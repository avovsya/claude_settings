import { CoordinatorDB } from "./db.js";
import { GitClient } from "./git-client.js";
import { TmuxClient } from "./tmux-client.js";
import { Logger } from "./logger.js";
import { Notifications } from "./notifications.js";
import type { CoordinatorConfig, MergeQueueRow } from "./types.js";

/**
 * Manages the merge queue.
 *
 * Merge flow:
 * 1. Worker completes (status: completed in session-bus)
 * 2. WorkerManager detects completion, coordinator creates merge approval request
 * 3. Human approves via `coord approve <session-id>`
 * 4. MergeManager executes the merge: git merge --no-ff from main worktree
 * 5. On success: cleanup (worktree remove, branch delete, tmux kill)
 * 6. On failure (conflict): mark failed, notify human
 *
 * Crash safety:
 * - `status=merging` is a recovery marker
 * - On restart, check actual git state for `merging` rows
 */
export class MergeManager {
  private notifications: Notifications;

  constructor(
    private readonly db: CoordinatorDB,
    private readonly git: GitClient,
    private readonly tmux: TmuxClient,
    private readonly log: Logger,
    private readonly config: CoordinatorConfig,
  ) {
    this.notifications = new Notifications(log);
  }

  /**
   * Enqueue a completed worker for merge.
   * Creates a merge approval request.
   */
  async queueForMerge(sessionId: string): Promise<void> {
    const worker = this.db.getWorker(sessionId);
    if (!worker) {
      this.log.error("Cannot queue for merge: worker not found", { sessionId });
      return;
    }

    // Create merge approval
    const approval = this.db.createApproval({
      session_id: sessionId,
      approval_type: "merge",
    });

    // Enqueue
    this.db.enqueueMerge({
      session_id: sessionId,
      branch: worker.branch,
      worktree: worker.worktree,
      trello_card_id: worker.trello_card_id ?? undefined,
      approval_id: approval.id,
    });

    this.log.info("Worker queued for merge", {
      sessionId,
      branch: worker.branch,
    });

    // Notify human
    await this.notifications.notifyMergeApproval(sessionId, worker.branch);
  }

  /**
   * Process the merge queue. Execute the next approved merge.
   */
  async processQueue(): Promise<void> {
    // Only one merge at a time
    const activeMerge = this.db.getActiveMerge();
    if (activeMerge) return;

    // Get next queued merge
    const next = this.db.getNextQueuedMerge();
    if (!next) return;

    // Check if the merge is approved (by specific approval_id, not session_id)
    if (next.approval_id) {
      const approval = this.db.getApproval(next.approval_id);
      if (approval && approval.status === "pending") {
        // Still waiting for approval
        return;
      }
    }

    // Execute the merge
    await this.executeMerge(next);
  }

  private async executeMerge(entry: MergeQueueRow): Promise<void> {
    const { session_id, branch, worktree } = entry;

    this.log.info("Starting merge", { session_id, branch });

    // Mark as merging (recovery marker)
    this.db.updateMergeStatus(entry.position, "merging");

    // Get diff stats for the merge message
    const diffStats = await this.git.diff(branch);

    // Execute the merge
    const mergeMessage = `Merge ${branch}: Worker ${session_id} completed`;
    const result = await this.git.merge(branch, mergeMessage);

    if (!result.success) {
      this.log.error("Merge failed", {
        session_id,
        branch,
        error: result.error,
      });

      this.db.updateMergeStatus(entry.position, "failed");

      await this.notifications.notifyWorkerState(
        session_id,
        "merge_failed",
        `Merge conflict on ${branch}: ${result.error}`,
      );
      return;
    }

    // Merge succeeded
    this.log.info("Merge completed", {
      session_id,
      branch,
      commit: result.commit,
    });

    // Update state atomically
    this.db.transaction(() => {
      this.db.updateMergeStatus(entry.position, "merged");
      this.db.updateWorkerStatus(session_id, "merged", {
        merge_commit: result.commit,
      });
    });

    // Cleanup (non-critical — failures here are logged but not fatal)
    await this.cleanup(session_id, branch, worktree);
  }

  private async cleanup(sessionId: string, branch: string, worktree: string): Promise<void> {
    const worker = this.db.getWorker(sessionId);

    // Kill tmux session
    if (worker?.tmux_session) {
      try {
        await this.tmux.killSession(worker.tmux_session);
        this.log.info("Killed tmux session", { session: worker.tmux_session });
      } catch (err) {
        this.log.warn("Failed to kill tmux session", {
          session: worker.tmux_session,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Remove worktree (NEVER --force)
    const removeResult = await this.git.worktreeRemove(worktree);
    if (!removeResult.success) {
      this.log.warn("Failed to remove worktree (may have uncommitted changes)", {
        worktree,
        error: removeResult.error,
      });
    }

    // Delete branch (lowercase -d, NEVER -D)
    const deleteResult = await this.git.branchDelete(branch);
    if (!deleteResult.success) {
      this.log.warn("Failed to delete branch", {
        branch,
        error: deleteResult.error,
      });
    }
  }
}
