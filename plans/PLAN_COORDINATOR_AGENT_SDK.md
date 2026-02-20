# Plan: Coordinator Agent SDK

**Status:** COMPLETED
**Branch:** `feature/coordinator-agent-sdk`
**Trello:** https://trello.com/c/w2BdRl4J/12-10-coordinator-agent-sdk
**Date:** 2026-02-20
**Completed:** 2026-02-20

### Deviations from Plan
- `trello-client.ts` and `recovery.ts` were not created as separate files. Trello integration is deferred to a follow-up card. Recovery logic was integrated directly into `coordinator.ts`.
- DB columns `commit` and `merge_commit` were renamed to `commit_hash` and `merge_commit_hash` to avoid SQLite reserved word conflicts.
- Session-bus reader implements its own file reading instead of importing `FileEventStore` directly, since the coordinator needs a read-only interface only.

---

## Architecture

### Overview

Replace the long-running Claude Code L1 Dispatcher session with a persistent Node.js daemon. The daemon runs a polling loop, monitors workers via session-bus and tmux, manages Trello state, and surfaces human approval gates.

### Key Architecture Decision: Hybrid Approach

**Workers remain tmux CLI processes.** The coordinator is a plain Node.js daemon (no LLM in the core loop).

Rationale:
- The SDK explicitly prohibits subagents from spawning their own subagents, breaking the Recursive Worker Model
- tmux workers support `tmux attach` for human debugging
- tmux workers auto-load CLAUDE.md without explicit `settingSources` configuration
- Workers can self-replicate (L2 → L3 → L4) via tmux
- Session-bus provides persistent, crash-safe event history independent of coordinator uptime

### System Diagram

```
L0: Human
    |  coord approve/reject/status (CLI)
    |  tmux attach (debugging)
    |
L1: Coordinator Daemon (Node.js, managed by launchd)
    |  +-- Reads session-bus (FileEventStore, direct import)
    |  +-- Controls tmux (shell out to tmux binary)
    |  +-- Manages git (shell out to git binary)
    |  +-- Updates Trello (REST API)
    |  +-- Persists state (coordinator.db, SQLite)
    |  +-- Surfaces approvals (files + notifications)
    |
    +--- Worker A (tmux, feature/auth)
    +--- Worker B (tmux, fix/crash-bug)
    +--- Worker C (tmux, feature/ui-revamp)
         +-- Worker C1 (tmux, child of C, self-replicated)
```

### State Stores

| Store | Owns | Technology |
|-------|------|------------|
| `coordinator.db` | Worker registry, dependency graph, merge queue, approvals, event cursors | SQLite (better-sqlite3, WAL mode, `busy_timeout=5000`) |
| Session-bus | Worker events, session metadata (status, branch, worktree) | File-based (existing MCP) — coordinator is **reader-only** |
| Trello | Card lifecycle (To Do → Implementing → Testing → Done) | Trello REST API |
| tmux | Live session state, pane content | tmux binary (direct exec) |

**Coordinator is reader-only on session-bus.** The coordinator reads events and metadata from session-bus files directly (importing `FileEventStore`). It does NOT publish events to session-bus, avoiding sequence counter collisions with the MCP server process. The coordinator's own state lives in `coordinator.db`.

---

## File Structure

```
coordinator/
+-- package.json
+-- tsconfig.json
+-- com.coordinator.agent.plist    # launchd user agent
+-- src/
|   +-- index.ts              # Entry point: args, PID lock, startup sequence
|   +-- coordinator.ts        # Main Coordinator class with poll loop
|   +-- db.ts                 # SQLite schema, migrations, CRUD
|   +-- worker-manager.ts     # Spawn, monitor, kill workers
|   +-- approval-manager.ts   # Human approval gate lifecycle
|   +-- merge-manager.ts      # Merge queue, conflict detection
|   +-- trello-client.ts      # Trello REST API client
|   +-- session-bus-reader.ts # Read-only wrapper around FileEventStore
|   +-- tmux-client.ts        # Shell out to tmux binary
|   +-- git-client.ts         # Shell out to git binary
|   +-- notifications.ts      # Terminal bell, osascript
|   +-- recovery.ts           # Startup recovery protocol
|   +-- prompt-generator.ts   # Generate worker prompt files
|   +-- types.ts              # Shared types and constants
|   +-- logger.ts             # Structured JSON logging with rotation
+-- src/cli/
|   +-- coord.ts              # CLI: approve/reject/list/status/spawn/logs
+-- README.md
```

**Location:** `coordinator/` directory in the main project root.

---

## Database Schema (coordinator.db)

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- Coordinator identity (singleton)
CREATE TABLE coordinator_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  pid                   INTEGER NOT NULL,
  started_at            TEXT NOT NULL,
  last_heartbeat_at     TEXT NOT NULL
);

-- Worker registry
-- session_id is coordinator-generated (UUID), passed to worker in prompt.
-- Worker uses this ID when calling session_bus_register_session.
CREATE TABLE workers (
  session_id            TEXT PRIMARY KEY,
  parent_session_id     TEXT,
  trello_card_id        TEXT,
  trello_card_url       TEXT,
  branch                TEXT NOT NULL,
  worktree              TEXT NOT NULL,
  tmux_session          TEXT,
  status                TEXT NOT NULL DEFAULT 'spawned',
  -- spawned|running|idle|awaiting_approval|completed|partial|blocked|dead|merged
  start_phase           INTEGER,
  remaining_splits      INTEGER,
  mode                  TEXT,  -- implementer|coordinator
  spawned_at            TEXT NOT NULL,
  completed_at          TEXT,
  commit_hash           TEXT,
  merge_commit_hash     TEXT,
  notes                 TEXT
);

-- Dependency graph
CREATE TABLE worker_dependencies (
  blocker_session_id    TEXT NOT NULL REFERENCES workers(session_id),
  blocked_session_id    TEXT NOT NULL REFERENCES workers(session_id),
  created_at            TEXT NOT NULL,
  PRIMARY KEY (blocker_session_id, blocked_session_id)
);

-- Event cursors (polling bookmarks)
-- Cursor advances by (timestamp, sequence) pair to avoid same-ms event skips.
CREATE TABLE event_cursors (
  session_id            TEXT PRIMARY KEY REFERENCES workers(session_id),
  last_event_timestamp  TEXT NOT NULL,
  last_event_sequence   INTEGER NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Approval records
CREATE TABLE approvals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL REFERENCES workers(session_id),
  approval_type         TEXT NOT NULL,  -- plan|merge|spawn_card
  plan_path             TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  -- pending|approved|rejected|superseded
  requested_at          TEXT NOT NULL,
  resolved_at           TEXT,
  feedback              TEXT
);

-- Merge queue
CREATE TABLE merge_queue (
  position              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL REFERENCES workers(session_id),
  branch                TEXT NOT NULL,
  worktree              TEXT NOT NULL,
  trello_card_id        TEXT,
  queued_at             TEXT NOT NULL,
  approval_id           INTEGER REFERENCES approvals(id),
  status                TEXT NOT NULL DEFAULT 'queued'
  -- queued|merging|merged|failed|skipped
);
```

---

## Key Design Decisions (from Expert Review)

### 1. Approval Delivery Protocol

Workers need to receive approval decisions. `tmux send-keys` is unreliable for Claude Code input.

**Solution:** Dual-channel delivery:
1. **Primary:** Write approval to a file at `~/.claude/coordinator/decisions/<session-id>.json`. Worker's prompt template instructs it to check this path when idle.
2. **Fallback:** When `tmux_detect_prompt_type` confirms `idle` state, use `tmux_launch_claude` with `prompt_file` containing the approval decision + `continue_session: true`.

The decision file format:
```json
{
  "session_id": "worker-abc123",
  "decision": "approved",
  "feedback": "Proceed as planned",
  "decided_at": "2026-02-20T14:35:00Z"
}
```

### 2. Worker Session ID Bootstrap

The coordinator generates a UUID for each worker at spawn time. This ID is:
- Passed to the worker in the prompt file
- Used by the coordinator to pre-register the session in session-bus (before Claude starts)
- Used by the worker when it calls `session_bus_register_session` (idempotent merge)

This ensures coordinator.db and session-bus are in sync from the moment of spawn.

### 3. Coordinator Pre-Registers Workers

Before launching Claude in the tmux pane, the coordinator:
1. Generates session ID (UUID)
2. Creates row in `workers` table
3. Calls `session_bus_register_session` with session_id, branch, worktree, parent_session_id
4. Creates tmux session
5. Launches Claude with prompt containing the session ID

This eliminates the window where a tmux session exists but session-bus has no entry.

**Exception to reader-only rule:** The coordinator writes to session-bus for pre-registration only. This is safe because the worker's session ID is unique and no MCP server instance will write to that session until the worker starts.

### 4. Event Cursor Advancement

Cursors use `(timestamp, sequence)` pairs, not timestamp alone. When filtering events:
```typescript
// Filter: events where (timestamp > cursor.timestamp) OR
//         (timestamp == cursor.timestamp AND sequence > cursor.sequence)
```
This prevents skipping same-millisecond events.

### 5. Process Lifecycle (launchd)

The coordinator runs as a macOS launchd user agent:
- Auto-restart on crash (`KeepAlive: true`)
- Start on login
- Logs to `~/.claude/coordinator/logs/`
- Sleep/wake detection via heartbeat drift: if `last_heartbeat_at` is >60s old when poll fires, treat as wake-from-sleep and run full recovery

### 6. Startup Sequence (strict order)

1. Parse config and CLI args
2. Acquire PID lock (`~/.claude/coordinator/coordinator.pid`) — verify with `kill -0`
3. Open `coordinator.db`, run migrations, set PRAGMAs
4. Register SIGTERM/SIGINT handlers
5. Instantiate `FileEventStore` (read-only), call `rebuildSequences()`
6. Run startup recovery (reconcile workers vs tmux/session-bus/git)
7. Start poll loop
8. Write startup log entry

### 7. Graceful Shutdown

On SIGTERM/SIGINT:
1. Set `shuttingDown = true` (stop accepting new work)
2. Wait for in-flight `git merge` to complete (30s timeout)
3. Mark timed-out merges as `failed`
4. Close SQLite connection
5. Remove PID file
6. Exit 0

---

## Implementation Phases

### Phase 1: Foundation (DB + types + daemon skeleton)

**Files:** `package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/db.ts`, `src/logger.ts`, `src/coordinator.ts` (skeleton)

1. Initialize Node.js project with TypeScript, better-sqlite3, zod
2. Define all shared types (WorkerStatus, ApprovalType, EventType enums via zod)
3. Implement DB module: schema creation, migrations, CRUD operations
4. Implement structured JSON logger with file rotation (`~/.claude/coordinator/logs/`)
5. Create coordinator skeleton: PID lock, SIGTERM handler, config parsing, poll loop shell
6. Generate launchd plist

**Build verification:** `npm run build` compiles, `node build/index.js --help` shows usage.

### Phase 2: Session-bus reader + tmux + git clients

**Files:** `src/session-bus-reader.ts`, `src/tmux-client.ts`, `src/git-client.ts`

1. Session-bus reader: import `FileEventStore` directly, expose typed read-only methods
   - `readEvents(sessionId, since?, eventTypes?)` → BusEvent[]
   - `getSession(sessionId)` → SessionMetadata
   - `listSessions(filter?)` → SessionMetadata[]
   - On init: call `rebuildSequences()` for correct sequence tracking
   - Document: shared directory assumption with session-bus MCP server
2. tmux client: shell out to tmux binary via `execFile`
   - `createSession(name, cwd)`, `killSession(name)`, `listSessions()`
   - `splitWindow(session, percent)`, `launchClaude(session, pane, promptFile, continueSession?)`
   - `capturePane(session, pane, lines)`, `sendKeys(session, pane, text)`
   - Distinguish `SERVER_NOT_RUNNING` from "no sessions" — separate error handling
3. git client: shell out to git binary
   - `worktreeAdd(branch, path)`, `worktreeRemove(path)` (NEVER `--force`), `worktreeList()`
   - `merge(branch)` (always `--no-ff`), `branchDelete(branch)` (always lowercase `-d`, NEVER `-D`)
   - `status()`, `log()`
4. All clients: retry with backoff on transient errors, structured error types

**Build verification:** Unit tests for each client pass.

### Phase 3: Worker lifecycle (spawn + monitor + detect completion)

**Files:** `src/worker-manager.ts`, `src/prompt-generator.ts`, `src/recovery.ts`, `src/notifications.ts`

1. **Spawn worker:**
   - Generate session ID (UUID)
   - Create git branch + worktree (`git worktree add -b <branch> <path> main`)
   - Pre-spawn checks: branch exists? worktree exists? trello_card_id already in workers table?
   - Copy submodules (parse `.gitmodules`, `cp -R` each)
   - Pre-register in session-bus (coordinator writes `register_session`)
   - Create row in coordinator.db `workers` table
   - Generate prompt file to `/tmp/<tmux-session>-prompt.md` (includes session ID)
   - Create tmux session (2-pane: 70/30 split)
   - Launch Claude: `unset CLAUDECODE && cat <prompt> | claude --dangerously-skip-permissions`
   - Update status to `running`

2. **Prompt generation** (ported from spawn-worker SKILL.md):
   - Task metadata: card name, branch, Trello URL, labels
   - Card description as requirements
   - Worker config: `session_id`, `remaining_splits`, `start_phase`
   - Recursive Worker Model explanation
   - Permission model disclaimer
   - Phase-specific start instruction
   - **New:** Session ID for session-bus registration
   - **New:** Decision file path for approval delivery

3. **Monitor workers (poll loop):**
   - Every 30s: for each non-terminal worker:
     - Read new session-bus events using cursor (timestamp, sequence pair)
     - Handle events: `phase_complete`, `plan_ready`, `blocked`, `error`, `build_result`, `wip_committed`, `context_warning`
     - Update worker status in coordinator.db
     - Advance cursor atomically with status change
   - Every 60s: cross-check tmux (`listSessions()`) for session liveness
   - Lazy capture: only `capturePane` when worker is event-silent for 5+ minutes
   - Sleep/wake detection: if heartbeat drift > 60s, run full recovery first

4. **Detect completion:**
   - Session-bus terminal status (`completed`/`partial`/`blocked`) → mark in coordinator.db
   - Parse COMPLETION_REPORT.md YAML front matter for structured artifacts
   - Check `/tmp/claude-phase-complete-*.json` as supplementary signal

5. **Startup recovery:**
   - Load coordinator.db (workers table)
   - Snapshot: tmux sessions, git worktrees, session-bus sessions (parallel)
   - Reconcile: session-bus terminal status wins; tmux absence + 2hr staleness = dead
   - Detect orphans (in session-bus/tmux but not coordinator.db) → flag for human review
   - Recover stuck merges (`status=merging` → check git state)
   - Unblock ready workers (dependency resolution)

6. **Notifications:**
   - Terminal bell (`\a`)
   - macOS notification via osascript

**Build verification:** Spawn a test worker, monitor it, detect phase events.

### Phase 4: Approval system + merge queue + Trello + CLI

**Files:** `src/approval-manager.ts`, `src/merge-manager.ts`, `src/trello-client.ts`, `src/cli/coord.ts`

1. **Approval manager:**
   - On `plan_ready` event: create approval record in DB, write pending file, notify human
   - Poll `~/.claude/coordinator/decisions/` for human responses
   - On approval: deliver to worker (write decision file + tmux fallback), update state
   - On rejection: deliver feedback, worker revises plan
   - Escalating reminders: immediate bell → 15min re-print → 2hr Trello annotation
   - Never auto-approve; no timeout leads to auto-approval

2. **Merge manager:**
   - Queue completed workers: create merge_queue entry + merge approval request
   - Human approves merge → execute: `git merge --no-ff` from main worktree
   - On success: update `workers.merge_commit`, `merge_queue.status = merged`
   - On conflict: `status = failed`, notify human, do NOT retry
   - Cleanup (after successful merge): `git worktree remove` (no --force), `git branch -d`
   - Crash recovery: `status=merging` → verify git state → complete or reset
   - **Constraint:** Human must not run git commands in main worktree during merge

3. **Trello client:**
   - REST API for: move card between lists, update card description, get card details
   - On spawn: move to "Implementing", append worker metadata
   - On completion: move to "Testing" (ask human for "Done")
   - On approval wait: annotate card with `[AWAITING APPROVAL]`
   - Retry with exponential backoff on rate limits

4. **`coord` CLI:**
   - `coord list` — show pending approvals
   - `coord approve [session-id]` — approve plan/merge (writes decision file)
   - `coord reject [session-id] "reason"` — reject with feedback
   - `coord status` — show all workers, phases, health (reads coordinator.db)
   - `coord spawn <card-name>` — write spawn request file, daemon picks it up
   - `coord logs <session-id>` — show session-bus events for a worker
   - `coord stop` — send SIGTERM to coordinator PID
   - Opens same SQLite DB with `busy_timeout = 5000`

**Build verification:** End-to-end: spawn worker → detect plan_ready → approve via CLI → worker continues → completion detected.

---

## Cross-Cutting Mitigations

### Crash Safety
- SQLite WAL mode with `busy_timeout = 5000`
- Event cursor + state change in same SQLite transaction (idempotent replay)
- Merge queue `merging` state for recovery (check actual git state on restart)
- Approval decision files persist across daemon restarts
- PID file with `kill -0` validation for single-instance enforcement

### Staleness Detection
- Workers with no session-bus events for 2+ hours AND no tmux session → mark `dead`
- Lazy `capturePane` only when event-silent for 5+ minutes (avoid unnecessary tmux subprocess spawns)
- Sleep/wake detection via heartbeat drift (>60s = run full recovery)
- Coordinator heartbeat updated every poll cycle

### Concurrency
- One coordinator daemon at a time (PID file lock before any store init)
- Sequential merges (only one merge in progress, enforced by queue)
- Parallel workers in separate worktrees (no file conflicts)
- Coordinator is reader-only on session-bus (except pre-registration with unique session IDs)

### Human Approval
- Never auto-approve plans or merges
- Dual-channel approval delivery (decision file + tmux fallback)
- Escalating notifications (bell → 15min reminder → 2hr Trello annotation)
- `coord` CLI for ergonomic response

### Git Safety
- Never use `git worktree remove --force`
- Never use `git branch -D` (always lowercase `-d`)
- Pre-spawn idempotency: check trello_card_id uniqueness, branch/worktree existence
- Human must not run git in main worktree during coordinator merge

### Logging
- Structured JSON to `~/.claude/coordinator/logs/coordinator.log`
- Log rotation (daily, keep 7 days)
- Mandatory log events: state transitions, git operations (full args + exit code), approvals, poll cycle duration
- Error deduplication: suppress repeated identical errors beyond 5/minute

---

## Dependencies

- `better-sqlite3` — SQLite bindings (synchronous, no async overhead)
- `zod` — Schema validation
- Node.js 18+

**NOT using Agent SDK for the core loop.** The coordinator is a plain Node.js daemon that:
- Imports `FileEventStore` from session-bus directly (read-only)
- Shells out to `tmux` for session management
- Shells out to `git` for worktree/merge operations
- Calls Trello REST API for card management

The Agent SDK may be used in a future iteration for intelligent decision-making (e.g., "which card should I work on next?"). The polling/state-machine loop is pure TypeScript with no LLM cost.

---

## Edge Cases

1. **Worker splits mid-execution:** Worker publishes `split_requested` event. Coordinator creates child worker entries with dependency edges, waits for human approval of the split plan.

2. **Multiple plans awaiting approval:** Queue approvals, present them FIFO. `coord list` shows all pending.

3. **Merge conflict:** `git merge` fails → `merge_queue.status = failed`, notify human, do NOT retry automatically.

4. **Coordinator killed during merge:** On restart, find `status=merging` rows, check git state (branch merged? still exists?), complete or reset.

5. **Worker commits WIP and stops (context exhaustion):** Session-bus shows `status: partial`. Coordinator notifies human; can auto-spawn continuation worker with `--continue` only after human approval.

6. **Trello API rate limits:** Retry with exponential backoff. Trello state is never critical-path.

7. **tmux server crash:** Distinguish from "no sessions" — if coordinator had tracked workers with tmux sessions but `listSessions` returns empty, flag as tmux server down rather than marking all workers dead.

8. **Branch name reuse:** Workers table may have old rows with same branch. Query by session_id (primary key), not by branch name.

9. **Sleep/wake:** Heartbeat drift detection triggers full recovery on wake, preventing false staleness marks from sleep duration.

10. **macOS App Nap:** launchd plist includes `ProcessType: Interactive` to prevent App Nap suspension.

---

## Testing Strategy

1. **Unit tests:** DB operations, prompt generation, event cursor logic, staleness detection
2. **Integration tests:** Spawn real tmux session, write session-bus events, verify coordinator reacts
3. **End-to-end:** Full cycle: spawn → monitor → approve → completion → merge

---

## Known Limitations

- **Not 24/7 on laptop:** Coordinator survives reboots (launchd) but not machine-off. Acceptable for single-developer workflow.
- **No web UI:** `coord` CLI and tmux pane are the interface.
- **No auto-prioritization:** Spawns workers on explicit request only.
- **Single machine:** No network communication.
- **Workers remain tmux CLI:** Converting workers to SDK sessions is card #11.
