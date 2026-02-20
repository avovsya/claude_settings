import { randomUUID } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { CoordinatorDB } from "./db.js";
import { SessionBusReader, type BusEvent } from "./session-bus-reader.js";
import { TmuxClient } from "./tmux-client.js";
import { GitClient } from "./git-client.js";
import { Logger } from "./logger.js";
import { Notifications } from "./notifications.js";
import { generatePrompt } from "./prompt-generator.js";
import {
  type CoordinatorConfig,
  type WorkerRow,
  type SpawnRequest,
  TERMINAL_WORKER_STATUSES,
  BUS_TERMINAL_STATUSES,
} from "./types.js";

export class WorkerManager {
  private notifications: Notifications;
  private lastCaptureContent = new Map<string, string>();
  private lastEventTime = new Map<string, number>();

  constructor(
    private readonly db: CoordinatorDB,
    private readonly bus: SessionBusReader,
    private readonly tmux: TmuxClient,
    private readonly git: GitClient,
    private readonly log: Logger,
    private readonly config: CoordinatorConfig,
  ) {
    this.notifications = new Notifications(log);
  }

  /**
   * Spawn a new worker for a task.
   */
  async spawnWorker(params: {
    branch: string;
    cardName: string;
    cardDescription: string;
    labels?: string[];
    trelloCardId?: string;
    trelloCardUrl?: string;
    remainingSplits?: number;
    startPhase?: number;
    parentSessionId?: string;
  }): Promise<WorkerRow> {
    const sessionId = `worker-${randomUUID().slice(0, 8)}`;
    const remainingSplits = params.remainingSplits ?? 2;
    const startPhase = params.startPhase ?? 1;

    // Derive paths
    const mainDir = dirname(this.config.mainWorktree);
    const projectName = basename(this.config.mainWorktree);
    const tmuxSessionName = params.branch.replace(/\//g, "-");
    const worktreePath = join(mainDir, `${projectName}-${tmuxSessionName}`);

    this.log.info("Spawning worker", {
      sessionId,
      branch: params.branch,
      worktree: worktreePath,
      remainingSplits,
      startPhase,
    });

    // Pre-spawn checks
    if (params.trelloCardId) {
      const existing = this.db.getWorkerByTrelloCard(params.trelloCardId);
      if (existing) {
        throw new Error(
          `Trello card ${params.trelloCardId} already has an active worker: ${existing.session_id}`,
        );
      }
    }

    const branchExists = await this.git.branchExists(params.branch);
    if (branchExists) {
      throw new Error(
        `Branch ${params.branch} already exists. Remove it first or use a different name.`,
      );
    }

    // Create git branch + worktree
    const worktreeResult = await this.git.worktreeAdd(params.branch, worktreePath);
    if (!worktreeResult.success) {
      throw new Error(`Failed to create worktree: ${worktreeResult.error}`);
    }

    // Copy submodules
    if (await this.git.hasSubmodules()) {
      await this.git.copySubmodules(worktreePath);
    }

    // Pre-register in session-bus
    await this.bus.preRegisterSession(sessionId, {
      branch: params.branch,
      worktree: worktreePath,
      parent_session_id: params.parentSessionId,
    });

    // Create row in coordinator.db
    const worker = this.db.insertWorker({
      session_id: sessionId,
      parent_session_id: params.parentSessionId,
      trello_card_id: params.trelloCardId,
      trello_card_url: params.trelloCardUrl,
      branch: params.branch,
      worktree: worktreePath,
      tmux_session: tmuxSessionName,
      start_phase: startPhase,
      remaining_splits: remainingSplits,
      mode: "implementer",
    });

    // Initialize event cursor
    this.db.upsertCursor(sessionId, new Date(0).toISOString(), -1);

    // Create tmux session (2-pane: 70/30)
    await this.tmux.createSession(tmuxSessionName, worktreePath);
    await this.tmux.splitWindow(tmuxSessionName, "vertical", 30, worktreePath);

    // Generate prompt file
    const promptPath = `/tmp/${tmuxSessionName}-prompt.md`;
    await generatePrompt(promptPath, {
      sessionId,
      cardName: params.cardName,
      branch: params.branch,
      trelloUrl: params.trelloCardUrl,
      cardDescription: params.cardDescription,
      labels: params.labels ?? [],
      remainingSplits,
      startPhase,
      decisionsDir: this.config.decisionsDir,
    });

    // Launch Claude in pane 1 (top pane)
    await this.tmux.launchClaude(tmuxSessionName, 1, {
      promptFile: promptPath,
      dangerouslySkipPermissions: true,
    });

    // Update status to running
    this.db.updateWorkerStatus(sessionId, "running");

    this.log.info("Worker spawned successfully", {
      sessionId,
      branch: params.branch,
      tmuxSession: tmuxSessionName,
      worktree: worktreePath,
    });

    return worker;
  }

  /**
   * Poll a worker for new session-bus events and react.
   */
  async pollWorker(worker: WorkerRow): Promise<void> {
    if (TERMINAL_WORKER_STATUSES.has(worker.status)) return;

    const cursor = this.db.getCursor(worker.session_id);
    const since = cursor?.last_event_timestamp;
    const sinceSequence = cursor?.last_event_sequence;

    // Read new events
    const events = await this.bus.readEvents(worker.session_id, {
      since,
      sinceSequence,
    });

    if (events.length > 0) {
      this.lastEventTime.set(worker.session_id, Date.now());
    }

    for (const event of events) {
      await this.handleEvent(worker, event);

      // Advance cursor after handling each event
      this.db.upsertCursor(worker.session_id, event.timestamp, event.sequence);
    }

    // Check session-bus metadata for terminal status
    const busMeta = await this.bus.getSession(worker.session_id);
    if (busMeta && BUS_TERMINAL_STATUSES.has(busMeta.status as any)) {
      const currentWorker = this.db.getWorker(worker.session_id);
      if (currentWorker && !TERMINAL_WORKER_STATUSES.has(currentWorker.status)) {
        this.log.info("Worker reached terminal status via session-bus", {
          session_id: worker.session_id,
          status: busMeta.status,
        });
        this.db.updateWorkerStatus(worker.session_id, busMeta.status as any, {
          completed_at: busMeta.completed_at ?? new Date().toISOString(),
          commit: busMeta.commit ?? undefined,
        });

        await this.notifications.notifyWorkerState(
          worker.session_id,
          busMeta.status,
          `Worker completed with status: ${busMeta.status}`,
        );
      }
    }

    // Lazy staleness check: only capture pane if event-silent for 5+ min
    if (events.length === 0 && worker.tmux_session) {
      const lastEvent = this.lastEventTime.get(worker.session_id) ?? Date.now();
      const silentMs = Date.now() - lastEvent;

      if (silentMs > this.config.lazyCaptureThresholdMs) {
        await this.checkWorkerStuck(worker);
      }
    }
  }

  private async handleEvent(worker: WorkerRow, event: BusEvent): Promise<void> {
    this.log.info("Worker event", {
      session_id: worker.session_id,
      event_type: event.event_type,
      data: event.data,
    });

    switch (event.event_type) {
      case "phase_complete": {
        const phase = event.data.phase as number | undefined;
        this.log.info("Worker completed phase", {
          session_id: worker.session_id,
          phase,
        });
        break;
      }

      case "plan_ready": {
        const planPath = event.data.plan_path as string | undefined;
        this.log.info("Worker plan ready, creating approval", {
          session_id: worker.session_id,
          plan_path: planPath,
        });

        // Create approval record
        this.db.createApproval({
          session_id: worker.session_id,
          approval_type: "plan",
          plan_path: planPath,
        });

        // Update worker status
        this.db.updateWorkerStatus(worker.session_id, "awaiting_approval");

        // Notify human
        await this.notifications.notifyApproval(
          worker.session_id,
          planPath ?? "unknown",
          "Plan is ready for review",
        );
        break;
      }

      case "blocked": {
        const reason = event.data.reason as string | undefined;
        this.log.warn("Worker is blocked", {
          session_id: worker.session_id,
          reason,
        });
        this.db.updateWorkerStatus(worker.session_id, "blocked", {
          notes: reason,
        });
        await this.notifications.notifyWorkerState(
          worker.session_id,
          "blocked",
          reason,
        );
        break;
      }

      case "error": {
        const message = event.data.message as string | undefined;
        const recoverable = event.data.recoverable as boolean | undefined;
        this.log.error("Worker error", {
          session_id: worker.session_id,
          message,
          recoverable,
        });
        if (!recoverable) {
          await this.notifications.notifyWorkerState(
            worker.session_id,
            "error",
            message,
          );
        }
        break;
      }

      case "wip_committed": {
        const commit = event.data.commit as string | undefined;
        const phase = event.data.phase as number | undefined;
        this.log.info("Worker committed WIP", {
          session_id: worker.session_id,
          commit,
          phase,
        });
        if (commit) {
          // Read current status from DB to avoid overwriting status set by
          // earlier events in the same poll batch
          const current = this.db.getWorker(worker.session_id);
          if (current) {
            this.db.updateWorkerStatus(worker.session_id, current.status, {
              commit,
            });
          }
        }
        break;
      }

      case "split_requested": {
        const plannedPhases = event.data.planned_phases as number | undefined;
        this.log.info("Worker requesting split", {
          session_id: worker.session_id,
          planned_phases: plannedPhases,
        });

        // Create approval for the split
        this.db.createApproval({
          session_id: worker.session_id,
          approval_type: "plan",
          plan_path: event.data.plan_path as string | undefined,
        });

        this.db.updateWorkerStatus(worker.session_id, "awaiting_approval");

        await this.notifications.notifyApproval(
          worker.session_id,
          (event.data.plan_path as string) ?? "split plan",
          `Worker wants to split into ${plannedPhases ?? "?"} phases`,
        );
        break;
      }

      case "build_result": {
        const passed = event.data.passed as boolean | undefined;
        this.log.info("Worker build result", {
          session_id: worker.session_id,
          passed,
        });
        break;
      }

      case "context_warning": {
        const compactionCount = event.data.compaction_count as number | undefined;
        this.log.warn("Worker context warning", {
          session_id: worker.session_id,
          compaction_count: compactionCount,
        });
        break;
      }

      case "session_started": {
        this.db.updateWorkerStatus(worker.session_id, "running");
        break;
      }
    }
  }

  private async checkWorkerStuck(worker: WorkerRow): Promise<void> {
    if (!worker.tmux_session) return;

    const hasTmux = await this.tmux.hasSession(worker.tmux_session);
    if (!hasTmux) {
      // tmux session is gone
      const lastEvent = this.lastEventTime.get(worker.session_id) ?? 0;
      const silentMs = Date.now() - lastEvent;

      if (silentMs > this.config.stalenessThresholdMs) {
        this.log.warn("Worker is stale, marking dead", {
          session_id: worker.session_id,
          tmux_session: worker.tmux_session,
          silentMs,
        });
        this.db.updateWorkerStatus(worker.session_id, "dead", {
          notes: "tmux_gone_and_stale",
        });
        await this.notifications.notifyWorkerState(
          worker.session_id,
          "dead",
          "tmux session gone and no events for 2+ hours",
        );
      }
      return;
    }

    // Capture pane and compare with previous
    try {
      const content = await this.tmux.capturePane(worker.tmux_session, 1, 30);
      const prev = this.lastCaptureContent.get(worker.session_id);

      if (prev && prev === content) {
        this.log.debug("Worker pane unchanged (may be stuck)", {
          session_id: worker.session_id,
        });
        // Don't mark dead yet — just log. Multiple consecutive unchanged captures
        // could trigger an interrupt in a future enhancement.
      }

      this.lastCaptureContent.set(worker.session_id, content);
    } catch (err) {
      this.log.debug("Failed to capture pane", {
        session_id: worker.session_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check for spawn request files dropped by the coord CLI.
   */
  async checkSpawnRequests(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.config.spawnRequestsDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(this.config.spawnRequestsDir, file);

      try {
        const content = await readFile(filePath, "utf8");
        const request = JSON.parse(content) as SpawnRequest;

        this.log.info("Processing spawn request", { file, request });

        // For now, require card_name at minimum
        if (!request.card_name && !request.card_url) {
          this.log.warn("Spawn request missing card identifier", { file });
          await unlink(filePath);
          continue;
        }

        // The actual Trello lookup and spawn will be handled by the
        // approval/trello integration. For now, log and remove the request.
        this.log.info("Spawn request acknowledged (Trello integration pending)", {
          card_name: request.card_name,
        });

        await unlink(filePath);
      } catch (err) {
        this.log.error("Failed to process spawn request", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
        // Remove corrupt request files
        await unlink(filePath).catch(() => {});
      }
    }
  }
}
