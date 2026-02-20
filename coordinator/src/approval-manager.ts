import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoordinatorDB } from "./db.js";
import { TmuxClient } from "./tmux-client.js";
import { Logger } from "./logger.js";
import { Notifications } from "./notifications.js";
import { ApprovalDecision, type CoordinatorConfig } from "./types.js";

/**
 * Manages human approval gates.
 *
 * Approval flow:
 * 1. Worker publishes plan_ready event on session-bus
 * 2. WorkerManager detects it, creates approval record in DB, notifies human
 * 3. Human runs `coord approve <session-id>` which writes a decision file
 * 4. ApprovalManager picks up the decision file and delivers it to the worker
 * 5. Worker continues (if approved) or revises (if rejected)
 *
 * Decision delivery (dual-channel):
 * - Primary: Write decision file that the coordinator monitors
 * - Fallback: When worker is detected as idle, deliver via tmux
 */
export class ApprovalManager {
  private notifications: Notifications;
  private reminderTimers = new Map<string, number>(); // sessionId -> last reminder timestamp
  private pendingDeliveries = new Map<string, { verdict: "approved" | "rejected"; feedback?: string }>();

  constructor(
    private readonly db: CoordinatorDB,
    private readonly tmux: TmuxClient,
    private readonly log: Logger,
    private readonly config: CoordinatorConfig,
  ) {
    this.notifications = new Notifications(log);
  }

  /**
   * Check for approval decision files from the coord CLI.
   */
  async checkDecisions(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.config.decisionsDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(this.config.decisionsDir, file);

      try {
        const content = await readFile(filePath, "utf8");
        const parsed = JSON.parse(content);
        const decision = ApprovalDecision.parse(parsed);

        await this.processDecision(decision);

        // Remove the decision file after processing
        await unlink(filePath);
      } catch (err) {
        this.log.error("Failed to process decision file", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
        // Remove corrupt decision files
        await unlink(filePath).catch(() => {});
      }
    }

    // Retry any pending deliveries from previous polls
    for (const [sessionId, pending] of this.pendingDeliveries) {
      const delivered = await this.deliverDecision(sessionId, pending.verdict, pending.feedback);
      if (delivered) {
        this.pendingDeliveries.delete(sessionId);
      }
    }

    // Check for stale approvals that need reminders
    await this.checkReminders();
  }

  private async processDecision(decision: ApprovalDecision): Promise<void> {
    const { session_id, decision: verdict, feedback } = decision;

    // Find the pending approval
    const approval = this.db.getPendingApprovalForWorker(session_id);
    if (!approval) {
      this.log.warn("Decision received but no pending approval found", {
        session_id,
      });
      return;
    }

    this.log.info("Processing approval decision", {
      session_id,
      approval_id: approval.id,
      approval_type: approval.approval_type,
      verdict,
      feedback,
    });

    // Update approval record
    this.db.resolveApproval(
      approval.id,
      verdict === "approved" ? "approved" : "rejected",
      feedback,
    );

    // Update worker status
    if (verdict === "approved") {
      this.db.updateWorkerStatus(session_id, "running");
    }
    // If rejected, worker stays in awaiting_approval until it publishes a new plan_ready

    // Deliver the decision to the worker via tmux
    const delivered = await this.deliverDecision(session_id, verdict, feedback);
    if (!delivered) {
      // Track for retry on next poll
      this.pendingDeliveries.set(session_id, { verdict, feedback });
    }

    // Clear reminder timer
    this.reminderTimers.delete(session_id);
  }

  private async deliverDecision(
    sessionId: string,
    verdict: "approved" | "rejected",
    feedback?: string,
  ): Promise<boolean> {
    const worker = this.db.getWorker(sessionId);
    if (!worker?.tmux_session) {
      this.log.warn("Cannot deliver decision: no tmux session", { sessionId });
      return false;
    }

    // Check if the worker is idle
    const state = await this.tmux.detectPromptType(worker.tmux_session, 1);

    if (state !== "idle") {
      this.log.info("Worker not idle, will retry delivery on next poll", {
        sessionId,
        state,
      });
      return false;
    }

    // Write a decision prompt file and deliver via tmux
    const message =
      verdict === "approved"
        ? feedback
          ? `Plan approved with feedback: ${feedback}\n\nProceed with implementation.`
          : "Plan approved. Proceed with implementation."
        : `Plan rejected: ${feedback ?? "No reason given"}\n\nPlease revise the plan and present an updated version.`;

    const promptPath = `/tmp/${worker.tmux_session}-decision.md`;
    await writeFile(promptPath, message, "utf8");

    await this.tmux.launchClaude(worker.tmux_session, 1, {
      promptFile: promptPath,
      continueSession: true,
      dangerouslySkipPermissions: true,
    });

    this.log.info("Decision delivered to worker", {
      sessionId,
      verdict,
      tmuxSession: worker.tmux_session,
    });
    return true;
  }

  private async checkReminders(): Promise<void> {
    const pending = this.db.getPendingApprovals();
    const now = Date.now();

    for (const approval of pending) {
      const requestedAt = new Date(approval.requested_at).getTime();
      const ageMs = now - requestedAt;
      const lastReminder = this.reminderTimers.get(approval.session_id) ?? requestedAt;
      const sinceReminder = now - lastReminder;

      // Remind every 15 minutes
      if (sinceReminder > 15 * 60 * 1000) {
        this.reminderTimers.set(approval.session_id, now);

        const ageMinutes = Math.floor(ageMs / 60_000);
        this.log.info("Sending approval reminder", {
          session_id: approval.session_id,
          ageMinutes,
          approval_type: approval.approval_type,
        });

        await this.notifications.notifyApproval(
          approval.session_id,
          approval.plan_path ?? "unknown",
          `Waiting ${ageMinutes}m for ${approval.approval_type} approval`,
        );
      }
    }
  }
}
