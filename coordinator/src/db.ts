import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ApprovalRow,
  ApprovalStatus,
  ApprovalType,
  CoordinatorStateRow,
  EventCursorRow,
  MergeQueueRow,
  MergeStatus,
  WorkerDependencyRow,
  WorkerMode,
  WorkerRow,
  WorkerStatus,
} from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  pid                   INTEGER NOT NULL,
  started_at            TEXT NOT NULL,
  last_heartbeat_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  session_id            TEXT PRIMARY KEY,
  parent_session_id     TEXT,
  trello_card_id        TEXT,
  trello_card_url       TEXT,
  branch                TEXT NOT NULL,
  worktree              TEXT NOT NULL,
  tmux_session          TEXT,
  status                TEXT NOT NULL DEFAULT 'spawned',
  start_phase           INTEGER,
  remaining_splits      INTEGER,
  mode                  TEXT,
  spawned_at            TEXT NOT NULL,
  completed_at          TEXT,
  commit_hash           TEXT,
  merge_commit_hash     TEXT,
  notes                 TEXT
);

CREATE TABLE IF NOT EXISTS worker_dependencies (
  blocker_session_id    TEXT NOT NULL REFERENCES workers(session_id),
  blocked_session_id    TEXT NOT NULL REFERENCES workers(session_id),
  created_at            TEXT NOT NULL,
  PRIMARY KEY (blocker_session_id, blocked_session_id)
);

CREATE TABLE IF NOT EXISTS event_cursors (
  session_id            TEXT PRIMARY KEY REFERENCES workers(session_id),
  last_event_timestamp  TEXT NOT NULL,
  last_event_sequence   INTEGER NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL REFERENCES workers(session_id),
  approval_type         TEXT NOT NULL,
  plan_path             TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  requested_at          TEXT NOT NULL,
  resolved_at           TEXT,
  feedback              TEXT
);

CREATE TABLE IF NOT EXISTS merge_queue (
  position              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL REFERENCES workers(session_id),
  branch                TEXT NOT NULL,
  worktree              TEXT NOT NULL,
  trello_card_id        TEXT,
  queued_at             TEXT NOT NULL,
  approval_id           INTEGER REFERENCES approvals(id),
  status                TEXT NOT NULL DEFAULT 'queued'
);
`;

export class CoordinatorDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // --- Coordinator State ---

  getCoordinatorState(): CoordinatorStateRow | undefined {
    return this.db
      .prepare("SELECT * FROM coordinator_state WHERE id = 1")
      .get() as CoordinatorStateRow | undefined;
  }

  upsertCoordinatorState(pid: number): CoordinatorStateRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO coordinator_state (id, pid, started_at, last_heartbeat_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET pid = ?, started_at = ?, last_heartbeat_at = ?`,
      )
      .run(pid, now, now, pid, now, now);
    return this.getCoordinatorState()!;
  }

  updateHeartbeat(): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE coordinator_state SET last_heartbeat_at = ? WHERE id = 1")
      .run(now);
  }

  // --- Workers ---

  getWorker(sessionId: string): WorkerRow | undefined {
    return this.db
      .prepare("SELECT * FROM workers WHERE session_id = ?")
      .get(sessionId) as WorkerRow | undefined;
  }

  getActiveWorkers(): WorkerRow[] {
    return this.db
      .prepare(
        "SELECT * FROM workers WHERE status NOT IN ('dead', 'merged') ORDER BY spawned_at",
      )
      .all() as WorkerRow[];
  }

  getAllWorkers(): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers ORDER BY spawned_at DESC")
      .all() as WorkerRow[];
  }

  getWorkerByTrelloCard(cardId: string): WorkerRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM workers WHERE trello_card_id = ? AND status NOT IN ('dead', 'merged')",
      )
      .get(cardId) as WorkerRow | undefined;
  }

  insertWorker(worker: {
    session_id: string;
    parent_session_id?: string;
    trello_card_id?: string;
    trello_card_url?: string;
    branch: string;
    worktree: string;
    tmux_session?: string;
    start_phase?: number;
    remaining_splits?: number;
    mode?: WorkerMode;
  }): WorkerRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workers (session_id, parent_session_id, trello_card_id, trello_card_url,
          branch, worktree, tmux_session, status, start_phase, remaining_splits, mode, spawned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'spawned', ?, ?, ?, ?)`,
      )
      .run(
        worker.session_id,
        worker.parent_session_id ?? null,
        worker.trello_card_id ?? null,
        worker.trello_card_url ?? null,
        worker.branch,
        worker.worktree,
        worker.tmux_session ?? null,
        worker.start_phase ?? null,
        worker.remaining_splits ?? null,
        worker.mode ?? null,
        now,
      );
    return this.getWorker(worker.session_id)!;
  }

  updateWorkerStatus(sessionId: string, status: WorkerStatus, extras?: {
    completed_at?: string;
    commit?: string;
    merge_commit?: string;
    tmux_session?: string;
    notes?: string;
  }): void {
    const now = new Date().toISOString();
    const sets = ["status = ?"];
    const params: unknown[] = [status];

    if (extras?.completed_at) {
      sets.push("completed_at = ?");
      params.push(extras.completed_at);
    }
    if (extras?.commit) {
      sets.push("commit_hash = ?");
      params.push(extras.commit);
    }
    if (extras?.merge_commit) {
      sets.push("merge_commit_hash = ?");
      params.push(extras.merge_commit);
    }
    if (extras?.tmux_session !== undefined) {
      sets.push("tmux_session = ?");
      params.push(extras.tmux_session);
    }
    if (extras?.notes) {
      sets.push("notes = ?");
      params.push(extras.notes);
    }

    params.push(sessionId);
    this.db
      .prepare(`UPDATE workers SET ${sets.join(", ")} WHERE session_id = ?`)
      .run(...params);
  }

  // --- Worker Dependencies ---

  addDependency(blockerId: string, blockedId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO worker_dependencies (blocker_session_id, blocked_session_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(blockerId, blockedId, now);
  }

  getDependencies(blockedId: string): WorkerDependencyRow[] {
    return this.db
      .prepare("SELECT * FROM worker_dependencies WHERE blocked_session_id = ?")
      .all(blockedId) as WorkerDependencyRow[];
  }

  getBlockedWorkers(blockerId: string): WorkerDependencyRow[] {
    return this.db
      .prepare("SELECT * FROM worker_dependencies WHERE blocker_session_id = ?")
      .all(blockerId) as WorkerDependencyRow[];
  }

  getUnblockedWorkers(): WorkerRow[] {
    return this.db
      .prepare(
        `SELECT w.* FROM workers w
         WHERE w.status = 'spawned'
         AND NOT EXISTS (
           SELECT 1 FROM worker_dependencies d
           JOIN workers blocker ON d.blocker_session_id = blocker.session_id
           WHERE d.blocked_session_id = w.session_id
           AND blocker.status NOT IN ('completed', 'merged')
         )
         ORDER BY w.spawned_at`,
      )
      .all() as WorkerRow[];
  }

  // --- Event Cursors ---

  getCursor(sessionId: string): EventCursorRow | undefined {
    return this.db
      .prepare("SELECT * FROM event_cursors WHERE session_id = ?")
      .get(sessionId) as EventCursorRow | undefined;
  }

  upsertCursor(sessionId: string, timestamp: string, sequence: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO event_cursors (session_id, last_event_timestamp, last_event_sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_event_timestamp = ?, last_event_sequence = ?, updated_at = ?`,
      )
      .run(sessionId, timestamp, sequence, now, timestamp, sequence, now);
  }

  /**
   * Advance cursor and update worker status atomically in a single transaction.
   */
  advanceCursorWithStatus(
    sessionId: string,
    cursorTimestamp: string,
    cursorSequence: number,
    newStatus?: WorkerStatus,
    extras?: { completed_at?: string; commit?: string },
  ): void {
    const txn = this.db.transaction(() => {
      this.upsertCursor(sessionId, cursorTimestamp, cursorSequence);
      if (newStatus) {
        this.updateWorkerStatus(sessionId, newStatus, extras);
      }
    });
    txn();
  }

  // --- Approvals ---

  createApproval(approval: {
    session_id: string;
    approval_type: ApprovalType;
    plan_path?: string;
  }): ApprovalRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO approvals (session_id, approval_type, plan_path, status, requested_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(approval.session_id, approval.approval_type, approval.plan_path ?? null, now);
    return this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(info.lastInsertRowid) as ApprovalRow;
  }

  getPendingApprovals(): ApprovalRow[] {
    return this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at")
      .all() as ApprovalRow[];
  }

  getPendingApprovalForWorker(sessionId: string): ApprovalRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
      )
      .get(sessionId) as ApprovalRow | undefined;
  }

  getApproval(id: number): ApprovalRow | undefined {
    return this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as ApprovalRow | undefined;
  }

  resolveApproval(id: number, status: ApprovalStatus, feedback?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE approvals SET status = ?, resolved_at = ?, feedback = ? WHERE id = ?")
      .run(status, now, feedback ?? null, id);
  }

  // --- Merge Queue ---

  enqueueMerge(entry: {
    session_id: string;
    branch: string;
    worktree: string;
    trello_card_id?: string;
    approval_id?: number;
  }): MergeQueueRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO merge_queue (session_id, branch, worktree, trello_card_id, queued_at, approval_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
      )
      .run(
        entry.session_id,
        entry.branch,
        entry.worktree,
        entry.trello_card_id ?? null,
        now,
        entry.approval_id ?? null,
      );
    return this.db
      .prepare("SELECT * FROM merge_queue WHERE position = ?")
      .get(info.lastInsertRowid) as MergeQueueRow;
  }

  getNextQueuedMerge(): MergeQueueRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM merge_queue WHERE status = 'queued' ORDER BY position ASC LIMIT 1",
      )
      .get() as MergeQueueRow | undefined;
  }

  getActiveMerge(): MergeQueueRow | undefined {
    return this.db
      .prepare("SELECT * FROM merge_queue WHERE status = 'merging' LIMIT 1")
      .get() as MergeQueueRow | undefined;
  }

  updateMergeStatus(position: number, status: MergeStatus): void {
    this.db
      .prepare("UPDATE merge_queue SET status = ? WHERE position = ?")
      .run(status, position);
  }

  /**
   * Run arbitrary function inside a transaction.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
