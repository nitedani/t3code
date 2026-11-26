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

// A parent's archive or delete takes its side chats among `threads`, so a kept side chat keeps the parent.
function keptWithSideChats(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  kept: (thread: OrchestrationV2ThreadShell) => boolean,
) {
  const parentsOfKept = new Set(
    threads.flatMap((thread) =>
      thread.lineage.sideChat === true && kept(thread) ? [thread.lineage.parentThreadId] : [],
    ),
  );
  return (thread: OrchestrationV2ThreadShell) => kept(thread) || parentsOfKept.has(thread.id);
}

/**
 * The threads one sweep deletes and archives, oldest first, at most THREADS_PER_SWEEP per list,
 * and the open pull requests of every expired thread they hold, oldest first. A settled thread's shelf clock is its updatedAt or a past snooze ending, whichever is later;
 * unarchiving counts as a change.
 */
function planThreadCleanup({
  threads,
  scheduledThreadIds,
  settings,
  now,
  threadIdle,
}: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly scheduledThreadIds: ReadonlySet<string>;
  readonly settings: ServerSettings;
  readonly now: number;
  readonly threadIdle: (thread: OrchestrationV2ThreadShell) => boolean;
}) {
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
  const idle = threads.filter(
    (thread) =>
      // Side chats follow their parent; subagent threads are not cleaned.
      isListedThreadLineage(thread.lineage) &&
      threadIdle(thread) &&
      // A guest is waiting on the owner; archiving would drop the request.
      (thread.pendingGuestMessageCount ?? 0) === 0,
  );
  const keep = (thread: OrchestrationV2ThreadShell) =>
    // A scheduled task's later runs post to its thread, and deleting the thread deletes the task.
    scheduledThreadIds.has(thread.id) ||
    // Pinning or snoozing a thread keeps it in view, archived or not.
    thread.pinnedAt != null ||
    isSnoozed(thread, now);
  // Deleting a parent takes all its side chats; archiving it takes the unarchived ones.
  const keptFromDeletion = keptWithSideChats(threads, keep);
  const keptFromArchive = keptWithSideChats(
    threads.filter((thread) => thread.archivedAt === null),
    keep,
  );
  const deletions =
    archivedThreadsAfterDays === null
      ? []
      : oldestExpired(
          archivedThreadsAfterDays,
          idle.flatMap((thread) =>
            thread.archivedAt === null || keptFromDeletion(thread)
              ? []
              : [
                  {
                    thread,
                    archivedAt: thread.archivedAt,
                    sinceMs: DateTime.toEpochMillis(thread.archivedAt),
                  },
                ],
          ),
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
  const shelf = idle.flatMap((thread) =>
    thread.archivedAt === null &&
    thread.settledOverride === "settled" &&
    thread.settledAt !== null &&
    !keptFromArchive(thread)
      ? [{ thread, sinceMs: shelfClockMs(thread), pullRequests: heldByPullRequests(thread) }]
      : [],
  );
  const sideChatsUnchangedSince = DateTime.makeUnsafe(now - settledThreadsAfterDays * DAY_MS);
  return {
    deletions,
    archives: oldestExpired(
      settledThreadsAfterDays,
      shelf.filter((candidate) => candidate.pullRequests.length === 0),
    ).map(({ thread }) => ({ thread, sideChatsUnchangedSince })),
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
    const plan = planThreadCleanup({
      threads,
      scheduledThreadIds: yield* sweep.readScheduledThreadIds,
      settings: serverSettings,
      now,
      threadIdle: (thread) => sweep.threadIdle(thread, now, serverSettings),
    });
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
      const entry = entryFor(thread);
      yield* engine.dispatch(command).pipe(
        Effect.map(() => entries.push({ ...entry, outcome: "removed", reason })),
        // The orchestrator refused the command, usually because the thread changed after this sweep read it.
        Effect.catchTags({
          OrchestratorDispatchError: (error) =>
            Effect.sync(() =>
              entries.push({
                ...entry,
                outcome: "kept",
                reason: typeof error.cause === "string" ? error.cause : error.message,
              }),
            ),
        }),
        Effect.catch((error) =>
          Effect.sync(() =>
            entries.push({ ...entry, outcome: "failed", reason: sweep.failureReason(error) }),
          ),
        ),
      );
    });
    const commandId = Effect.fnUntraced(function* (thread: OrchestrationV2ThreadShell) {
      return CommandId.make(`server:storage-cleanup:${thread.id}:${yield* random.uuidV4()}`);
    });
    // A task enabled since the plan was read still keeps the thread, and so does one in a side chat it takes.
    const takesScheduledTask = Effect.fnUntraced(function* (
      thread: OrchestrationV2ThreadShell,
      cascade: ReadonlyArray<OrchestrationV2ThreadShell>,
    ) {
      const scheduled = yield* sweep.readScheduledThreadIds;
      if (!keptWithSideChats(cascade, (candidate) => scheduled.has(candidate.id))(thread))
        return false;
      entries.push({
        ...entryFor(thread),
        outcome: "kept",
        reason: "thread has a scheduled task",
      });
      return true;
    });
    let deleted = false;
    for (const { thread, archivedAt } of plan.deletions) {
      if (yield* takesScheduledTask(thread, threads)) continue;
      // A delete can't be undone, so a rule changed since the plan stops it; the change sweeps again.
      const { storageCleanup } = yield* settingsService.getSettings;
      if (storageCleanup.archivedThreadsAfterDays !== archivedThreadsAfterDays) break;
      yield* apply(
        thread,
        {
          type: "thread.delete",
          commandId: yield* commandId(thread),
          threadId: thread.id,
          expectedArchivedAt: archivedAt,
        },
        `Deleted after ${archivedThreadsAfterDays} days archived`,
      );
      deleted ||= entries.at(-1)?.outcome === "removed";
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
    const unarchived = threads.filter((thread) => thread.archivedAt === null);
    for (const { thread, sideChatsUnchangedSince } of plan.archives) {
      if (yield* takesScheduledTask(thread, unarchived)) continue;
      yield* apply(
        thread,
        {
          type: "thread.archive",
          commandId: yield* commandId(thread),
          threadId: thread.id,
          expectedUpdatedAt: thread.updatedAt,
          sideChatsUnchangedSince,
        },
        `Archived after ${settledThreadsAfterDays} days settled`,
      );
    }
    return deleted;
  });
  return { retireThreads };
});
