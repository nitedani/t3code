import { CommandId, isListedThreadLineage } from "@t3tools/contracts";
import type {
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  StorageCleanupThreadEntry,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import { isSnoozed } from "./orchestration-v2/ThreadSettlementService.ts";
import * as Settings from "./serverSettings.ts";
import { visibleThreadPullRequests } from "./sourceControl/threadPullRequests.ts";

const DAY_MS = 86_400_000;
// At most this many threads per rule per sweep. Each deletion requests another sweep,
// so a deletion backlog drains faster than the hourly tick.
const THREADS_PER_SWEEP = 100;

type Rule = "archive" | "delete";

/** A listed thread followed by the side chats its archive or delete takes with it. */
type Family = readonly [OrchestrationV2ThreadShell, ...ReadonlyArray<OrchestrationV2ThreadShell>];

// A verdict reads a family's shells, whose every change it depends on moves updatedAt for the
// orchestrator's ifUnchanged to refuse, and these facts, which no shell carries and which are read
// again before each action. pullRequests is the exception: a merge or reopen waits for the next sweep.
interface Facts {
  readonly settings: ServerSettings;
  readonly scheduledThreadIds: ReadonlySet<string>;
  readonly delegatingThreadIds: ReadonlySet<string>;
}

type Verdict =
  | { readonly type: "not-due" }
  | { readonly type: "held"; readonly reason: string }
  | {
      readonly type: "open-pull-requests";
      readonly sinceMs: number;
      readonly links: ReadonlyArray<ThreadPullRequestLink>;
    }
  | { readonly type: "due"; readonly sinceMs: number };

const ruleDays = (rule: Rule, settings: ServerSettings) =>
  settings.storageCleanup[
    rule === "delete" ? "archivedThreadsAfterDays" : "settledThreadsAfterDays"
  ];

/**
 * When the family last changed, or null while it is off the rule's shelf. A settled family's
 * clock is the latest updatedAt or past snooze ending of a member; unarchiving counts as a change.
 */
function clockOf(rule: Rule, family: Family, now: number): number | null {
  const [thread] = family;
  if (rule === "delete")
    // A side chat brought back from the archive is in use.
    return thread.archivedAt !== null && family.every((member) => member.archivedAt !== null)
      ? DateTime.toEpochMillis(thread.archivedAt)
      : null;
  if (
    thread.archivedAt !== null ||
    thread.settledOverride !== "settled" ||
    thread.settledAt === null
  )
    return null;
  return Math.max(
    ...family.flatMap((member) => [
      DateTime.toEpochMillis(member.updatedAt),
      ...[member.lastSnoozeWakeAt, member.snoozedUntil]
        .filter((at) => at != null)
        .map(DateTime.toEpochMillis)
        .filter((ms) => ms <= now),
    ]),
  );
}

type SweepError = { readonly message: string };

export interface ThreadRetentionSweep {
  readonly readThreads: Effect.Effect<
    {
      readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
      readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
    },
    SweepError
  >;
  readonly readScheduledThreadIds: Effect.Effect<ReadonlySet<string>, SweepError>;
  readonly threadIdle: (
    thread: OrchestrationV2ThreadShell,
    now: number,
    settings: ServerSettings,
  ) => boolean;
  readonly failureReason: (error: SweepError) => string;
}

export const makeThreadRetention = Effect.fn("ThreadRetention.make")(function* (
  sweep: ThreadRetentionSweep,
) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const settingsService = yield* Settings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const readFacts = Effect.all({
    settings: settingsService.getSettings,
    scheduledThreadIds: sweep.readScheduledThreadIds,
    // The shell hides work from rewound turns while their delegated child can still run.
    delegatingThreadIds: projections
      .listDelegatingThreadIds()
      .pipe(Effect.map((threadIds) => new Set<string>(threadIds))),
  });

  /** Why this member keeps its whole family where it is, or null. */
  const holdOf = (thread: OrchestrationV2ThreadShell, facts: Facts, now: number) => {
    if (!sweep.threadIdle(thread, now, facts.settings) || facts.delegatingThreadIds.has(thread.id))
      return "thread is working";
    // A guest is waiting on the owner; archiving would drop the request.
    if ((thread.pendingGuestMessageCount ?? 0) > 0) return "a guest is waiting";
    // A scheduled task's later runs post to its thread, and deleting the thread deletes the task.
    if (facts.scheduledThreadIds.has(thread.id)) return "thread has a scheduled task";
    // Pinning or snoozing a thread keeps it in view, archived or not.
    if (thread.pinnedAt != null) return "thread is pinned";
    if (isSnoozed(thread, now)) return "thread is snoozed";
    return null;
  };

  /** What one rule makes of one family under these facts. */
  const verdict = (rule: Rule, family: Family, facts: Facts, now: number): Verdict => {
    const days = ruleDays(rule, facts.settings);
    const sinceMs = clockOf(rule, family, now);
    if (days === null || sinceMs === null || sinceMs > now - days * DAY_MS)
      return { type: "not-due" };
    for (const member of family) {
      const reason = holdOf(member, facts, now);
      if (reason !== null) return { type: "held", reason };
    }
    if (rule === "delete") return { type: "due", sinceMs };
    const [thread] = family;
    // A project that keeps pull requests keeps a settled thread while a pull request it shows is open.
    const links = resolveProjectSettings(facts.settings, thread.projectId).settings
      .sidebarAutoSettleKeepPullRequests
      ? visibleThreadPullRequests(thread.pullRequests ?? []).filter(
          (link) => link.snapshot?.state === "open",
        )
      : [];
    return links.length > 0
      ? { type: "open-pull-requests", sinceMs, links }
      : { type: "due", sinceMs };
  };

  /**
   * The families one sweep deletes and archives, oldest first and at most THREADS_PER_SWEEP per
   * rule, and the open pull requests of every due family they keep, oldest first.
   */
  const plan = (threads: ReadonlyArray<OrchestrationV2ThreadShell>, facts: Facts, now: number) => {
    const sideChats = new Map<string | null, Array<OrchestrationV2ThreadShell>>();
    for (const thread of threads) {
      if (thread.lineage.sideChat !== true) continue;
      const siblings = sideChats.get(thread.lineage.parentThreadId) ?? [];
      sideChats.set(thread.lineage.parentThreadId, [...siblings, thread]);
    }
    // Side chats follow their parent; subagent threads are not cleaned.
    const listed = threads.filter((thread) => isListedThreadLineage(thread.lineage));
    const judged = (rule: Rule) =>
      listed.map((thread) => {
        // Deleting a parent takes all its side chats; archiving it takes the unarchived ones.
        const family: Family = [
          thread,
          ...(sideChats.get(thread.id) ?? []).filter(
            (sideChat) => rule === "delete" || sideChat.archivedAt === null,
          ),
        ];
        return { family, verdict: verdict(rule, family, facts, now) };
      });
    const oldestFirst = <Candidate extends { readonly sinceMs: number }>(
      candidates: ReadonlyArray<Candidate>,
    ) => candidates.toSorted((left, right) => left.sinceMs - right.sinceMs);
    const due = (judgements: ReturnType<typeof judged>) =>
      oldestFirst(
        judgements.flatMap(({ family, verdict }) =>
          verdict.type === "due" ? [{ family, sinceMs: verdict.sinceMs }] : [],
        ),
      )
        .slice(0, THREADS_PER_SWEEP)
        .map(({ family }) => family);
    const archives = judged("archive");
    return {
      deletions: due(judged("delete")),
      archives: due(archives),
      pullRequestHolds: oldestFirst(
        archives.flatMap(({ verdict }) => (verdict.type === "open-pull-requests" ? [verdict] : [])),
      ).map(({ links }) => links),
    };
  };

  let refreshStart = 0;
  const retireInto = Effect.fnUntraced(function* (
    now: number,
    entries: StorageCleanupThreadEntry[],
  ) {
    const { storageCleanup } = yield* settingsService.getSettings;
    if (
      storageCleanup.settledThreadsAfterDays === null &&
      storageCleanup.archivedThreadsAfterDays === null
    )
      return;
    const { projects, threads } = yield* sweep.readThreads;
    const { deletions, archives, pullRequestHolds } = plan(threads, yield* readFacts, now);
    const entryFor = (thread: OrchestrationV2ThreadShell) => ({
      projectPath:
        projects.find((project) => project.id === thread.projectId)?.workspaceRoot ?? null,
      threadId: thread.id,
      threadTitle: thread.title,
    });
    // The only dispatch: it asks the plan's verdict again on facts read just now.
    const act = Effect.fnUntraced(function* (rule: Rule, family: Family) {
      const [thread] = family;
      const facts = yield* readFacts;
      const judged = verdict(rule, family, facts, now);
      if (judged.type === "held")
        entries.push({ ...entryFor(thread), outcome: "kept", reason: judged.reason });
      if (judged.type !== "due") return;
      const days = ruleDays(rule, facts.settings);
      const command = {
        type: rule === "delete" ? ("thread.delete" as const) : ("thread.archive" as const),
        commandId: CommandId.make(`server:storage-cleanup:${thread.id}:${yield* random.uuidV4()}`),
        threadId: thread.id,
        // The orchestrator takes the family only if no member changed since this read.
        ifUnchanged: family.map((member) => ({ threadId: member.id, updatedAt: member.updatedAt })),
      };
      const result = yield* engine.dispatch(command).pipe(
        Effect.as({
          outcome: "removed" as const,
          reason:
            rule === "delete"
              ? `Deleted after ${days} days archived`
              : `Archived after ${days} days settled`,
        }),
        // The orchestrator refused the command, usually because the thread changed after this sweep read it.
        Effect.catchTags({
          OrchestratorDispatchError: (error) =>
            Effect.succeed({
              outcome: "kept" as const,
              reason: typeof error.cause === "string" ? error.cause : error.message,
            }),
        }),
        Effect.catch((error) =>
          Effect.succeed({ outcome: "failed" as const, reason: sweep.failureReason(error) }),
        ),
      );
      entries.push({ ...entryFor(thread), ...result });
    });
    for (const family of deletions) yield* act("delete", family);
    // A settled thread's links are read only on request, so a merge or close would go unseen.
    // A refresh that finds a pull request still open leaves its thread's clock alone, so each
    // sweep moves on to the next held threads instead of asking about the oldest ones again.
    const start =
      pullRequestHolds.length > THREADS_PER_SWEEP ? refreshStart % pullRequestHolds.length : 0;
    refreshStart = start + THREADS_PER_SWEEP;
    yield* Effect.forEach(
      [...pullRequestHolds.slice(start), ...pullRequestHolds.slice(0, start)]
        .slice(0, THREADS_PER_SWEEP)
        .flat(),
      pullRequestSync.requestSync,
      { discard: true },
    );
    for (const family of archives) yield* act("archive", family);
  });

  /** Archives and deletes the threads the retention rules make due, one report entry each. */
  const retire = Effect.fn("ThreadRetention.retire")(function* (now: number) {
    const entries: StorageCleanupThreadEntry[] = [];
    yield* retireInto(now, entries).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          entries.push({
            outcome: "failed",
            reason: sweep.failureReason(error),
            projectPath: null,
            threadId: null,
            threadTitle: null,
          });
          yield* Effect.logWarning("thread cleanup failed", { error });
        }),
      ),
    );
    return entries;
  });
  return { retire };
});
