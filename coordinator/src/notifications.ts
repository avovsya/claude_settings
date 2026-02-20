import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export class Notifications {
  constructor(private readonly log: Logger) {}

  /**
   * Ring the terminal bell.
   */
  bell(): void {
    process.stderr.write("\x07");
  }

  /**
   * Send a macOS notification via osascript.
   */
  async macosNotification(title: string, message: string): Promise<void> {
    try {
      await execFileAsync("osascript", [
        "-e",
        `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
      ]);
    } catch (err) {
      this.log.debug("Failed to send macOS notification", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Notify the human about a pending approval.
   */
  async notifyApproval(workerSessionId: string, planPath: string, summary: string): Promise<void> {
    // Terminal bell
    this.bell();

    // macOS notification
    await this.macosNotification(
      "Plan Approval Required",
      `Worker ${workerSessionId}: ${summary}`,
    );

    // Log prominently to stderr (coordinator's tmux pane)
    const banner = `
${"=".repeat(60)}
  PLAN APPROVAL REQUIRED
  Worker:  ${workerSessionId}
  Plan:    ${planPath}

  To approve:  coord approve ${workerSessionId}
  To reject:   coord reject ${workerSessionId} "reason"
${"=".repeat(60)}
`;
    process.stderr.write(banner);

    this.log.info("Approval notification sent", {
      session_id: workerSessionId,
      plan_path: planPath,
    });
  }

  /**
   * Notify about a merge approval request.
   */
  async notifyMergeApproval(workerSessionId: string, branch: string): Promise<void> {
    this.bell();

    await this.macosNotification(
      "Merge Approval Required",
      `Worker ${workerSessionId}: merge ${branch} to main`,
    );

    const banner = `
${"=".repeat(60)}
  MERGE APPROVAL REQUIRED
  Worker:  ${workerSessionId}
  Branch:  ${branch}

  To approve:  coord approve ${workerSessionId}
  To reject:   coord reject ${workerSessionId} "reason"
${"=".repeat(60)}
`;
    process.stderr.write(banner);

    this.log.info("Merge approval notification sent", {
      session_id: workerSessionId,
      branch,
    });
  }

  /**
   * Notify about a worker state change.
   */
  async notifyWorkerState(
    workerSessionId: string,
    state: string,
    details?: string,
  ): Promise<void> {
    this.log.info("Worker state changed", {
      session_id: workerSessionId,
      state,
      details,
    });

    // Only notify for notable states
    if (state === "dead" || state === "blocked" || state === "partial") {
      this.bell();
      await this.macosNotification(
        `Worker ${state.toUpperCase()}`,
        `${workerSessionId}: ${details ?? state}`,
      );
    }
  }
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
