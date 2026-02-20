import { CoordinatorDB } from "./db.js";
import { Logger } from "./logger.js";
import type { CoordinatorConfig, WorkerRow } from "./types.js";
import { TERMINAL_WORKER_STATUSES, BUS_TERMINAL_STATUSES } from "./types.js";
import { SessionBusReader } from "./session-bus-reader.js";
import { TmuxClient } from "./tmux-client.js";
import { GitClient } from "./git-client.js";
import { WorkerManager } from "./worker-manager.js";
import { ApprovalManager } from "./approval-manager.js";
import { MergeManager } from "./merge-manager.js";

export class Coordinator {
  private db: CoordinatorDB;
  private log: Logger;
  private bus: SessionBusReader;
  private tmux: TmuxClient;
  private git: GitClient;
  private workerManager: WorkerManager;
  private approvalManager: ApprovalManager;
  private mergeManager: MergeManager;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(private readonly config: CoordinatorConfig) {
    this.log = new Logger(config.logDir);
    this.db = new CoordinatorDB(config.dbPath);
    this.bus = new SessionBusReader(config.sessionBusDir);
    this.tmux = new TmuxClient(this.log);
    this.git = new GitClient(config.mainWorktree, this.log);
    this.workerManager = new WorkerManager(this.db, this.bus, this.tmux, this.git, this.log, config);
    this.approvalManager = new ApprovalManager(this.db, this.tmux, this.log, config);
    this.mergeManager = new MergeManager(this.db, this.git, this.tmux, this.log, config);
  }

  async start(): Promise<void> {
    this.log.info("Coordinator starting", {
      pid: process.pid,
      mainWorktree: this.config.mainWorktree,
    });

    // Register coordinator state
    this.db.upsertCoordinatorState(process.pid);

    // Initialize session-bus reader
    await this.bus.init();

    // Run startup recovery
    await this.runRecovery();

    // Start poll loop
    this.pollTimer = setInterval(() => {
      this.pollCycle().catch((err) => {
        this.log.error("Poll cycle error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.pollIntervalMs);

    this.log.info("Coordinator started, poll loop active", {
      intervalMs: this.config.pollIntervalMs,
    });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info("Coordinator shutting down");

    // Stop poll loop
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for in-flight merge (with timeout)
    const activeMerge = this.db.getActiveMerge();
    if (activeMerge) {
      this.log.warn("In-flight merge detected during shutdown, waiting up to 30s", {
        session_id: activeMerge.session_id,
        branch: activeMerge.branch,
      });

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const current = this.db.getActiveMerge();
        if (!current) break;
        await sleep(1000);
      }

      // If still merging after timeout, mark failed
      const stillMerging = this.db.getActiveMerge();
      if (stillMerging) {
        this.log.error("Merge timed out during shutdown, marking failed", {
          session_id: stillMerging.session_id,
        });
        this.db.updateMergeStatus(stillMerging.position, "failed");
      }
    }

    // Close DB
    this.db.close();
    this.log.info("Coordinator shutdown complete");
  }

  private async runRecovery(): Promise<void> {
    this.log.info("Running startup recovery");

    const workers = this.db.getActiveWorkers();
    if (workers.length === 0) {
      this.log.info("No active workers to recover");
      return;
    }

    // Snapshot external state
    const [tmuxSessions, worktrees] = await Promise.all([
      this.tmux.listSessions(),
      this.git.worktreeList(),
    ]);

    const tmuxNames = new Set(tmuxSessions.map((s) => s.name));
    const worktreePaths = new Set(worktrees.map((w) => w.path));

    for (const worker of workers) {
      await this.reconcileWorker(worker, tmuxNames, worktreePaths);
    }

    // Recover stuck merges
    const stuckMerge = this.db.getActiveMerge();
    if (stuckMerge) {
      this.log.warn("Found stuck merge from previous run", {
        session_id: stuckMerge.session_id,
        branch: stuckMerge.branch,
      });
      // Check if the branch is actually merged
      const isMerged = await this.git.isBranchMerged(stuckMerge.branch);
      if (isMerged) {
        this.log.info("Stuck merge was actually completed, finalizing");
        this.db.updateMergeStatus(stuckMerge.position, "merged");
        this.db.updateWorkerStatus(stuckMerge.session_id, "merged");
      } else {
        this.log.info("Stuck merge was not completed, resetting to queued");
        this.db.updateMergeStatus(stuckMerge.position, "queued");
      }
    }

    this.log.info("Recovery complete", { workersReconciled: workers.length });
  }

  private async reconcileWorker(
    worker: WorkerRow,
    tmuxNames: Set<string>,
    worktreePaths: Set<string>,
  ): Promise<void> {
    if (TERMINAL_WORKER_STATUSES.has(worker.status)) return;

    // Check session-bus for terminal status
    try {
      const busMeta = await this.bus.getSession(worker.session_id);
      if (busMeta && BUS_TERMINAL_STATUSES.has(busMeta.status as any)) {
        this.log.info("Worker has terminal status in session-bus", {
          session_id: worker.session_id,
          busStatus: busMeta.status,
        });
        this.db.updateWorkerStatus(worker.session_id, busMeta.status as any, {
          completed_at: busMeta.completed_at ?? new Date().toISOString(),
          commit: busMeta.commit ?? undefined,
        });
        return;
      }
    } catch {
      // Session might not exist in bus yet
    }

    // Check tmux
    const hasTmux = worker.tmux_session ? tmuxNames.has(worker.tmux_session) : false;

    // Check worktree
    const hasWorktree = worktreePaths.has(worker.worktree);

    if (!hasWorktree) {
      this.log.warn("Worker worktree missing, flagging for review", {
        session_id: worker.session_id,
        worktree: worker.worktree,
      });
      this.db.updateWorkerStatus(worker.session_id, "dead", {
        notes: "worktree_missing_on_recovery",
      });
      return;
    }

    if (!hasTmux && worker.tmux_session) {
      // Check staleness via session-bus last event
      try {
        const events = await this.bus.readEvents(worker.session_id, { lastN: 1 });
        const lastEvent = events[0];
        const lastActivityMs = lastEvent
          ? Date.now() - new Date(lastEvent.timestamp).getTime()
          : Date.now() - new Date(worker.spawned_at).getTime();

        if (lastActivityMs > this.config.stalenessThresholdMs) {
          this.log.warn("Worker is stale (no tmux, no recent events), marking dead", {
            session_id: worker.session_id,
            lastActivityMs,
          });
          this.db.updateWorkerStatus(worker.session_id, "dead", {
            notes: "stale_on_recovery",
          });
        } else {
          this.log.info("Worker tmux gone but has recent activity, monitoring", {
            session_id: worker.session_id,
          });
        }
      } catch {
        this.log.warn("Cannot read events for worker, marking dead", {
          session_id: worker.session_id,
        });
        this.db.updateWorkerStatus(worker.session_id, "dead", {
          notes: "unreadable_on_recovery",
        });
      }
    }
  }

  private async pollCycle(): Promise<void> {
    if (this.shuttingDown) return;

    // Sleep/wake detection
    const state = this.db.getCoordinatorState();
    if (state) {
      const lastHeartbeat = new Date(state.last_heartbeat_at).getTime();
      const drift = Date.now() - lastHeartbeat;
      if (drift > this.config.sleepWakeThresholdMs + this.config.pollIntervalMs) {
        this.log.warn("Detected wake from sleep, running recovery", { driftMs: drift });
        await this.runRecovery();
      }
    }

    // Update heartbeat
    this.db.updateHeartbeat();

    // Poll each active worker for new events
    const workers = this.db.getActiveWorkers();
    for (const worker of workers) {
      if (TERMINAL_WORKER_STATUSES.has(worker.status)) continue;
      await this.workerManager.pollWorker(worker);
    }

    // Check for approval responses
    await this.approvalManager.checkDecisions();

    // Process merge queue
    await this.mergeManager.processQueue();

    // Check for spawn requests
    await this.workerManager.checkSpawnRequests();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
