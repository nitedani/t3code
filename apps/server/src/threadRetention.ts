import { CommandId, isListedThreadLineage } from "@t3tools/contracts";
import type {
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  StorageCleanupThreadEntry,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import { isSnoozed } from "./orchestration-v2/ThreadSettlementService.ts";
import * as Settings from "./serverSettings.ts";
import { visibleThreadPullRequests } from "./sourceControl/threadPullRequests.ts";

const DAY_MS = 86_400_000;
// At most this many threads per rule per sweep. Each deletion requests another sweep,
// so a deletion backlog drains faster than the hourly tick.
const THREADS_PER_SWEEP = 100;

interface HoldContext {
  readonly now: number;
  readonly scheduledThreadIds: ReadonlySet<string>;
  readonly threadIdle: (thread: OrchestrationV2ThreadShell) => boolean;
}

/** Why this thread keeps its whole family where it is, or null. */
function holdOf(
  thread: OrchestrationV2ThreadShell,
  { now, scheduledThreadIds, threadIdle }: HoldContext,
) {
  if (!threadIdle(thread)) return "thread is working";
  // A guest is waiting on the owner; archiving would drop the request.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "a guest is waiting";
  // A scheduled task's later runs post to its thread, and deleting the thread deletes the task.
  if (scheduledThreadIds.has(thread.id)) return "thread has a scheduled task";
  // Pinning or snoozing a thread keeps it in view, archived or not.
  if (thread.pinnedAt != null) return "thread is pinned";
  if (isSnoozed(thread, now)) return "thread is snoozed";
  return null;
}

const SIDE_CHAT_HOLDS: ReadonlySet<string> = new Set([
  "thread is working",
  "thread has a scheduled task",
  "thread is pinned",
  "thread is snoozed",
]);

/** A family is a listed thread followed by the side chats its archive or delete takes with it. */
function familyHold(family: ReadonlyArray<OrchestrationV2ThreadShell>, context: HoldContext) {
  for (const [index, member] of family.entries()) {
    const hold = holdOf(member, context);
    if (hold !== null && (index === 0 || SIDE_CHAT_HOLDS.has(hold))) return hold;
  }
  return null;
}

/**
 * The threads one sweep deletes and archives, oldest first, at most THREADS_PER_SWEEP per list,
 * each with the family it takes, and the open pull requests of every expired thread they hold, oldest first.
 * A settled family's shelf clock is the latest updatedAt or past snooze ending of a member it takes;
 * unarchiving counts as a change.
 */
function planThreadCleanup({
  threads,
  settings,
  hold,
}: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly settings: ServerSettings;
  readonly hold: HoldContext;
}) {
  const { now } = hold;
  const { settledThreadsAfterDays, archivedThreadsAfterDays } = settings.storageCleanup;
  const expired = <Candidate extends { readonly sinceMs: number }>(
    days: number,
    candidates: ReadonlyArray<Candidate>,
  ) =>
    candidates
      .filter((candidate) => candidate.sinceMs <= now - days * DAY_MS)
      .toSorted((left, right) => left.sinceMs - right.sinceMs);
  const oldestExpired = <Candidate extends { readonly sinceMs: number }>(
    days: number,
    candidates: ReadonlyArray<Candidate>,
  ) => expired(days, candidates).slice(0, THREADS_PER_SWEEP);
  const sideChats = new Map<string | null, Array<OrchestrationV2ThreadShell>>();
  for (const thread of threads) {
    if (thread.lineage.sideChat !== true) continue;
    const siblings = sideChats.get(thread.lineage.parentThreadId) ?? [];
    sideChats.set(thread.lineage.parentThreadId, [...siblings, thread]);
  }
  // Side chats follow their parent; subagent threads are not cleaned.
  const listed = threads.filter((thread) => isListedThreadLineage(thread.lineage));
  // Deleting a parent takes all its side chats; archiving it takes the unarchived ones.
  const deletionFamily = (thread: OrchestrationV2ThreadShell) => [
    thread,
    ...(sideChats.get(thread.id) ?? []),
  ];
  const archiveFamily = (thread: OrchestrationV2ThreadShell) => [
    thread,
    ...(sideChats.get(thread.id) ?? []).filter((sideChat) => sideChat.archivedAt === null),
  ];
  const deletions =
    archivedThreadsAfterDays === null
      ? []
      : oldestExpired(
          archivedThreadsAfterDays,
          listed.flatMap((thread) => {
            if (thread.archivedAt === null) return [];
            const family = deletionFamily(thread);
            // A side chat brought back from the archive is in use.
            return family.every((member) => member.archivedAt !== null) &&
              familyHold(family, hold) === null
              ? [{ thread, family, sinceMs: DateTime.toEpochMillis(thread.archivedAt) }]
              : [];
          }),
        );
  if (settledThreadsAfterDays === null) return { deletions, archives: [], pullRequestHolds: [] };
  // A project that keeps pull requests keeps a settled thread while a pull request it shows is open.
  const heldByPullRequests = (thread: OrchestrationV2ThreadShell) =>
    resolveProjectSettings(settings, thread.projectId).settings.sidebarAutoSettleKeepPullRequests
      ? visibleThreadPullRequests(thread.pullRequests ?? []).filter(
          (link) => link.snapshot?.state === "open",
        )
      : [];
  const shelfClockMs = (thread: OrchestrationV2ThreadShell) =>
    Math.max(
      DateTime.toEpochMillis(thread.updatedAt),
      ...[thread.lastSnoozeWakeAt, thread.snoozedUntil]
        .filter((at) => at != null)
        .map(DateTime.toEpochMillis)
        .filter((ms) => ms <= now),
    );
  const shelf = listed.flatMap((thread) => {
    if (
      thread.archivedAt !== null ||
      thread.settledOverride !== "settled" ||
      thread.settledAt === null
    )
      return [];
    const family = archiveFamily(thread);
    return familyHold(family, hold) === null
      ? [
          {
            thread,
            family,
            sinceMs: Math.max(...family.map(shelfClockMs)),
            pullRequests: heldByPullRequests(thread),
          },
        ]
      : [];
  });
  return {
    deletions,
    archives: oldestExpired(
      settledThreadsAfterDays,
      shelf.filter((candidate) => candidate.pullRequests.length === 0),
    ),
    pullRequestHolds: expired(
      settledThreadsAfterDays,
      shelf.filter((candidate) => candidate.pullRequests.length > 0),
    ).map((candidate) => candidate.pullRequests),
  };
}

/** What retention needs from the storage sweep that runs it. */
export interface ThreadRetentionSweep<ReadError, TaskReadError> {
  readonly readThreads: Effect.Effect<
    {
      readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
      readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
    },
    ReadError
  >;
  readonly readScheduledThreadIds: Effect.Effect<ReadonlySet<string>, TaskReadError>;
  readonly threadIdle: (
    thread: OrchestrationV2ThreadShell,
    now: number,
    settings: ServerSettings,
  ) => boolean;
  readonly failureReason: (error: { readonly message: string }) => string;
}

export const makeThreadRetention = Effect.fn("ThreadRetention.make")(function* <
  ReadError,
  TaskReadError,
>(sweep: ThreadRetentionSweep<ReadError, TaskReadError>) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const settingsService = yield* Settings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;

  let refreshStart = 0;
  /** Archives and deletes the threads the retention rules make due, and reports whether it deleted any. */
  const retireThreads = Effect.fn("ThreadRetention.retireThreads")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: StorageCleanupThreadEntry[],
  ) {
    const { settledThreadsAfterDays, archivedThreadsAfterDays } = serverSettings.storageCleanup;
    if (settledThreadsAfterDays === null && archivedThreadsAfterDays === null) return false;
    const { projects, threads } = yield* sweep.readThreads;
    const hold: HoldContext = {
      now,
      scheduledThreadIds: yield* sweep.readScheduledThreadIds,
      threadIdle: (thread) => sweep.threadIdle(thread, now, serverSettings),
    };
    const plan = planThreadCleanup({ threads, settings: serverSettings, hold });
    const entryFor = (thread: OrchestrationV2ThreadShell) => ({
      projectPath:
        projects.find((project) => project.id === thread.projectId)?.workspaceRoot ?? null,
      threadId: thread.id,
      threadTitle: thread.title,
    });
    const apply = Effect.fnUntraced(function* (
      thread: OrchestrationV2ThreadShell,
      command: OrchestrationV2ServerCommand,
      reason: string,
    ) {
      const result = yield* engine.dispatch(command).pipe(
        Effect.as({ outcome: "removed" as const, reason }),
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
      return result.outcome;
    });
    const commandId = Effect.fnUntraced(function* (thread: OrchestrationV2ThreadShell) {
      return CommandId.make(`server:storage-cleanup:${thread.id}:${yield* random.uuidV4()}`);
    });
    // A task enabled since the plan was read still keeps the family.
    const heldSincePlan = Effect.fnUntraced(function* (
      thread: OrchestrationV2ThreadShell,
      family: ReadonlyArray<OrchestrationV2ThreadShell>,
    ) {
      const reason = familyHold(family, {
        ...hold,
        scheduledThreadIds: yield* sweep.readScheduledThreadIds,
      });
      if (reason === null) return false;
      entries.push({ ...entryFor(thread), outcome: "kept", reason });
      return true;
    });
    let deleted = false;
    // The orchestrator takes the family only if no member changed since this read.
    const asRead = (family: ReadonlyArray<OrchestrationV2ThreadShell>) =>
      family.map((member) => ({ threadId: member.id, updatedAt: member.updatedAt }));
    for (const { thread, family } of plan.deletions) {
      if (yield* heldSincePlan(thread, family)) continue;
      // A delete can't be undone, so a rule changed since the plan stops it; the change sweeps again.
      const { storageCleanup } = yield* settingsService.getSettings;
      if (storageCleanup.archivedThreadsAfterDays !== archivedThreadsAfterDays) break;
      const outcome = yield* apply(
        thread,
        {
          type: "thread.delete",
          commandId: yield* commandId(thread),
          threadId: thread.id,
          ifUnchanged: asRead(family),
        },
        `Deleted after ${archivedThreadsAfterDays} days archived`,
      );
      if (outcome === "removed") deleted = true;
    }
    // A settled thread's links are read only on request, so a merge or close would go unseen.
    // A refresh that finds a pull request still open leaves its thread's clock alone, so each
    // sweep moves on to the next held threads instead of asking about the oldest ones again.
    const holds = plan.pullRequestHolds;
    const start = holds.length > THREADS_PER_SWEEP ? refreshStart % holds.length : 0;
    refreshStart = start + THREADS_PER_SWEEP;
    yield* Effect.forEach(
      [...holds.slice(start), ...holds.slice(0, start)].slice(0, THREADS_PER_SWEEP).flat(),
      pullRequestSync.requestSync,
      { discard: true },
    );
    for (const { thread, family } of plan.archives) {
      if (yield* heldSincePlan(thread, family)) continue;
      yield* apply(
        thread,
        {
          type: "thread.archive",
          commandId: yield* commandId(thread),
          threadId: thread.id,
          ifUnchanged: asRead(family),
        },
        `Archived after ${settledThreadsAfterDays} days settled`,
      );
    }
    return deleted;
  });
  return { retireThreads };
});
