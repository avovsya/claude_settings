import { z } from "zod";

// --- Worker Status ---

export const WorkerStatus = z.enum([
  "spawned",
  "running",
  "idle",
  "awaiting_approval",
  "completed",
  "partial",
  "blocked",
  "dead",
  "merged",
]);
export type WorkerStatus = z.infer<typeof WorkerStatus>;

export const TERMINAL_WORKER_STATUSES = new Set<WorkerStatus>([
  "completed",
  "partial",
  "blocked",
  "dead",
  "merged",
]);

// --- Approval ---

export const ApprovalType = z.enum(["plan", "merge", "spawn_card"]);
export type ApprovalType = z.infer<typeof ApprovalType>;

export const ApprovalStatus = z.enum([
  "pending",
  "approved",
  "rejected",
  "superseded",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

// --- Merge Queue ---

export const MergeStatus = z.enum([
  "queued",
  "merging",
  "merged",
  "failed",
  "skipped",
]);
export type MergeStatus = z.infer<typeof MergeStatus>;

// --- Worker Mode ---

export const WorkerMode = z.enum(["implementer", "coordinator"]);
export type WorkerMode = z.infer<typeof WorkerMode>;

// --- DB Row Types ---

export interface CoordinatorStateRow {
  id: number;
  pid: number;
  started_at: string;
  last_heartbeat_at: string;
}

export interface WorkerRow {
  session_id: string;
  parent_session_id: string | null;
  trello_card_id: string | null;
  trello_card_url: string | null;
  branch: string;
  worktree: string;
  tmux_session: string | null;
  status: WorkerStatus;
  start_phase: number | null;
  remaining_splits: number | null;
  mode: WorkerMode | null;
  spawned_at: string;
  completed_at: string | null;
  commit_hash: string | null;
  merge_commit_hash: string | null;
  notes: string | null;
}

export interface WorkerDependencyRow {
  blocker_session_id: string;
  blocked_session_id: string;
  created_at: string;
}

export interface EventCursorRow {
  session_id: string;
  last_event_timestamp: string;
  last_event_sequence: number;
  updated_at: string;
}

export interface ApprovalRow {
  id: number;
  session_id: string;
  approval_type: ApprovalType;
  plan_path: string | null;
  status: ApprovalStatus;
  requested_at: string;
  resolved_at: string | null;
  feedback: string | null;
}

export interface MergeQueueRow {
  position: number;
  session_id: string;
  branch: string;
  worktree: string;
  trello_card_id: string | null;
  queued_at: string;
  approval_id: number | null;
  status: MergeStatus;
}

// --- Approval Decision File ---

export const ApprovalDecision = z.object({
  session_id: z.string(),
  decision: z.enum(["approved", "rejected"]),
  feedback: z.string().optional(),
  decided_at: z.string(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

// --- Spawn Request ---

export const SpawnRequest = z.object({
  card_name: z.string().optional(),
  card_id: z.string().optional(),
  card_url: z.string().optional(),
  remaining_splits: z.number().default(2),
  start_phase: z.number().default(1),
  requested_at: z.string(),
});
export type SpawnRequest = z.infer<typeof SpawnRequest>;

// --- Configuration ---

export interface CoordinatorConfig {
  /** Path to the main git worktree */
  mainWorktree: string;
  /** Base directory for session-bus data */
  sessionBusDir: string;
  /** Path to coordinator.db */
  dbPath: string;
  /** Path to PID file */
  pidPath: string;
  /** Path to coordinator log directory */
  logDir: string;
  /** Path to approval decisions directory */
  decisionsDir: string;
  /** Path to spawn requests directory */
  spawnRequestsDir: string;
  /** Poll interval in milliseconds */
  pollIntervalMs: number;
  /** Staleness threshold in milliseconds (default: 2 hours) */
  stalenessThresholdMs: number;
  /** Lazy capture threshold in milliseconds (default: 5 minutes) */
  lazyCaptureThresholdMs: number;
  /** Sleep/wake detection threshold in milliseconds (default: 60 seconds) */
  sleepWakeThresholdMs: number;
}

export const DEFAULT_CONFIG: CoordinatorConfig = {
  mainWorktree: "",
  sessionBusDir: `${process.env.HOME}/.claude/session-bus`,
  dbPath: `${process.env.HOME}/.claude/coordinator/coordinator.db`,
  pidPath: `${process.env.HOME}/.claude/coordinator/coordinator.pid`,
  logDir: `${process.env.HOME}/.claude/coordinator/logs`,
  decisionsDir: `${process.env.HOME}/.claude/coordinator/decisions`,
  spawnRequestsDir: `${process.env.HOME}/.claude/coordinator/spawn-requests`,
  pollIntervalMs: 30_000,
  stalenessThresholdMs: 2 * 60 * 60 * 1000,
  lazyCaptureThresholdMs: 5 * 60 * 1000,
  sleepWakeThresholdMs: 60_000,
};

// --- Session-bus event types (re-exported for convenience) ---

export type BusEventType =
  | "phase_complete"
  | "plan_ready"
  | "blocked"
  | "error"
  | "wip_committed"
  | "split_requested"
  | "build_result"
  | "session_started"
  | "context_warning";

export type BusSessionStatus =
  | "active"
  | "idle"
  | "completed"
  | "partial"
  | "blocked"
  | "dead";

export const BUS_TERMINAL_STATUSES = new Set<BusSessionStatus>([
  "completed",
  "partial",
  "blocked",
  "dead",
]);
