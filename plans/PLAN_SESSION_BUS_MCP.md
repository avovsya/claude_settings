# Plan: Session Bus MCP Server

**Status:** IMPLEMENTED
**Card:** https://trello.com/c/qofkn9H5
**Branch:** `feature/session-bus-mcp-server`
**Tier:** 2 (High-Value, 3-6h)
**Date:** 2026-02-20

---

## 1. Architecture Overview

A standalone MCP server providing file-based pub/sub messaging between Claude Code sessions. Workers publish structured events, coordinators and dispatchers subscribe to them — eliminating the human as the sole message bus.

### Design Principles

1. **File-based**: All state persisted as JSON files (survives restarts, debuggable)
2. **Lock-free**: Atomic writes via tmp+rename, per-session isolation
3. **Optional**: Existing workflows unaffected if bus is unavailable
4. **Append-only events**: Events are immutable once written
5. **Convention over configuration**: Follows tmux-control MCP patterns exactly

### Target Architecture

```
Coordinator/Dispatcher Session
    │
    ├─ session_bus_list_sessions()     → enumerate active workers
    ├─ session_bus_read_events(id)     → poll for new events from worker
    ├─ session_bus_get_session(id)     → check worker status/metadata
    │
    └─ session_bus_publish(...)        → publish own events (plan_ready, etc.)

Worker Session
    │
    ├─ session_bus_register_session()  → register on spawn
    ├─ session_bus_publish(...)        → emit phase_complete, blocked, etc.
    └─ session_bus_update_session()    → update status on completion
```

---

## 2. Directory Structure

**Base directory:** `~/.claude/session-bus/` (configurable via `SESSION_BUS_DIR` env var)

```
~/.claude/session-bus/
├── sessions/
│   ├── {session_id}/
│   │   ├── metadata.json                             # Session registration + status
│   │   ├── {ms_timestamp}-{seq}-{event_type}.json    # Individual event files
│   │   ├── {ms_timestamp}-{seq}-{event_type}.json
│   │   └── ...
│   └── {session_id}/
│       ├── metadata.json
│       └── ...
└── (no indices/archive in v1 — keep it simple)
```

**Why individual event files (not JSONL):**
- Atomic writes per event (no append-lock needed)
- GC can delete individual events
- Directory listing shows new events since last check
- Consistent with phase-completion-hook signal pattern

**Filename format:** `{ms_timestamp}-{sequence}-{event_type}.json`
- `Date.now()` millisecond wall-clock timestamp (13 digits, zero-padded) for lexicographic = chronological sort
- Per-session sequence counter (5 digits, zero-padded) for same-millisecond disambiguation
- Event type suffix for human readability
- Example: `1708915234567-00003-phase_complete.json`

**Why `Date.now()` not `process.hrtime()`:** hrtime is relative to process start, not wall clock. After a restart, timestamps would reset, breaking monotonicity across restarts.

---

## 3. Data Models

### Session Metadata (`metadata.json`)

```typescript
interface SessionMetadata {
  session_id: string;           // Claude Code session ID (primary key)
  status: SessionStatus;        // Current lifecycle state
  created_at: string;           // ISO 8601
  updated_at: string;           // ISO 8601, updated on every status change

  // Identity (all optional — lazy registration may not have these)
  branch?: string;              // Git branch name
  worktree?: string;            // Absolute worktree path

  // Hierarchy
  parent_session_id?: string;   // Parent coordinator session

  // Terminal state
  completed_at?: string;        // ISO 8601, set when status becomes terminal
  commit?: string;              // Commit hash at completion
}

type SessionStatus =
  | "active"      // Session running, publishing events
  | "idle"        // Waiting for human input
  | "completed"   // All phases done
  | "partial"     // Context exhausted (leaf worker)
  | "blocked"     // External dependency
  | "dead";       // Cleaned up
```

**v1 simplification (per expert review):** Removed `tmux_session`, `trello_card_id/url`, `remaining_splits`, `start_phase`, `current_phase`, `mode`. These are higher-level orchestration concerns — workers can pass them in event payloads if needed.

### Event Schema

```typescript
interface BusEvent {
  session_id: string;           // Which session published this
  timestamp: string;            // ISO 8601
  sequence: number;             // Per-session monotonic counter
  event_type: EventType;        // Discriminator
  data: Record<string, any>;    // Event-specific payload
}

type EventType =
  | "phase_complete"            // Worker finished a phase
  | "plan_ready"                // Plan written, awaiting approval
  | "blocked"                   // Worker stuck on dependency
  | "error"                     // Worker encountered error
  | "wip_committed"             // Worker committed WIP checkpoint
  | "split_requested"           // Worker wants to split to coordinator
  | "build_result"              // Build succeeded or failed
  | "session_started"           // Session began executing
  | "context_warning";          // Context getting low / compacted
```

### Event Payloads (per type)

```typescript
// phase_complete
{ phase: number; status: "completed" | "partial" | "blocked"; artifacts?: string[]; commit?: string; summary?: string; }

// plan_ready
{ plan_path: string; phase_count: number; }

// blocked
{ reason: string; blocker_type: "human_approval" | "dependency" | "error" | "other"; }

// error
{ message: string; phase?: number; recoverable: boolean; }

// wip_committed
{ commit: string; phase: number; message: string; }

// split_requested
{ planned_phases: number; reason: string; }

// build_result
{ passed: boolean; error_summary?: string; duration_sec?: number; }

// session_started
{ mode?: "implementer" | "coordinator"; }

// context_warning
{ compaction_count: number; }
```

---

## 4. MCP Tool API

### Tool 1: `session_bus_publish`

Publish an event from the current session.

```typescript
Params:
  session_id: string        // Required: publishing session's ID
  event_type: EventType     // Required: one of the defined event types
  data: object              // Required: event-specific payload

Returns: { event_file: string, timestamp: string, sequence: number }
```

**Behavior:**
- Creates session directory if not exists (`mkdir -p`)
- If session not registered, auto-creates minimal metadata: `{ session_id, status: "active", created_at, updated_at }` (no other fields populated)
- Writes event file atomically (tmp + rename, same directory to ensure same filesystem)
- Updates `metadata.json` `updated_at` timestamp

### Tool 2: `session_bus_read_events`

Read events for a session, with optional filtering.

```typescript
Params:
  session_id: string        // Required: session to read events from
  event_types?: string[]    // Optional: filter by event type(s)
  since?: string            // Optional: ISO 8601 timestamp, only events after this
  last_n?: number           // Optional: return only last N events

Returns: { events: BusEvent[], count: number }
```

**Behavior:**
- Lists event files in session directory, sorted lexicographically (= chronological)
- Applies filters (type, timestamp, count)
- Handles ENOENT gracefully (session not found → empty array)
- Skips `.tmp` files and unparseable files (corrupt/partial → warns in stderr)

### Tool 3: `session_bus_list_sessions`

List all registered sessions with optional status filter.

```typescript
Params:
  status?: SessionStatus    // Optional: filter by status
  parent_session_id?: string // Optional: filter by parent (children of coordinator)

Returns: { sessions: SessionMetadata[], count: number }
```

**Behavior:**
- Reads all `metadata.json` files from `sessions/` directory
- Applies status and parent filters
- Sorted by `updated_at` descending (most recent first)
- Skips sessions with corrupt/unparseable metadata.json (logs warning to stderr)

### Tool 4: `session_bus_register_session`

Explicitly register a session with full metadata.

```typescript
Params:
  session_id: string              // Required
  branch?: string
  worktree?: string
  parent_session_id?: string

Returns: { registered: true, metadata_path: string }
```

**Behavior:**
- Creates session directory + metadata.json (status: "active")
- If already registered, merges new fields (does not overwrite existing non-null fields)
- Publishes implicit `session_started` event

### Tool 5: `session_bus_get_session`

Get metadata for a specific session.

```typescript
Params:
  session_id: string        // Required

Returns: SessionMetadata (or error if not found)
```

### Tool 6: `session_bus_update_session`

Update session status or metadata.

```typescript
Params:
  session_id: string        // Required
  status?: SessionStatus    // New status
  commit?: string           // Terminal commit hash
  branch?: string           // Update branch if not set
  worktree?: string         // Update worktree if not set

Returns: { updated: true, metadata: SessionMetadata }
```

**Behavior:**
- Atomic read-modify-write of metadata.json (read → merge → write tmp → rename)
- Sets `updated_at` to now
- If status is terminal (completed/partial/blocked/dead), sets `completed_at`

### Tool 7: `session_bus_garbage_collect`

Clean up old sessions and events.

```typescript
Params:
  max_age_hours?: number    // Delete events older than N hours (default: 168 = 7 days)
  dry_run?: boolean         // If true, report what would be deleted without deleting (default: false)
  status?: SessionStatus    // Only clean sessions with this status (default: all terminal)

Returns: { sessions_deleted: number, events_deleted: number, bytes_freed: number, details: string[] }
```

**Behavior:**
- Scans all sessions
- For terminal sessions (completed/partial/blocked/dead) older than `max_age_hours`: delete entire directory
- For active sessions: delete individual events older than `max_age_hours`
- Dry run mode: reports without deleting

### Tool 8: `session_bus_health`

Check if the bus is operational.

```typescript
Params: (none)

Returns: { ok: boolean, base_dir: string, session_count: number, writable: boolean }
```

**Behavior:**
- Checks base directory exists and is writable
- Counts session directories
- Returns health summary

---

## 5. File Layout (Source)

Follow tmux-control MCP pattern exactly:

```
mcp-servers/session-bus/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts              # Server entry, tool registration, main()
    ├── types.ts              # BusError, ErrorCodes, interfaces, constants
    ├── store.ts              # FileEventStore: atomic read/write/list/gc operations
    └── tools/
        ├── publish.ts        # session_bus_publish tool
        ├── events.ts         # session_bus_read_events tool
        ├── sessions.ts       # register, get, update, list session tools
        └── gc.ts             # session_bus_garbage_collect + health tools
```

---

## 6. Implementation Order

### Phase A: Core (store + types)
1. `types.ts` — Error codes, interfaces, constants
2. `store.ts` — FileEventStore class (atomic writes, reads, GC)
3. `package.json` + `tsconfig.json` — Project config

### Phase B: Tools
4. `tools/publish.ts` — `session_bus_publish`
5. `tools/events.ts` — `session_bus_read_events`
6. `tools/sessions.ts` — register, get, update, list
7. `tools/gc.ts` — `session_bus_garbage_collect` + `session_bus_health`

### Phase C: Server + Build
8. `index.ts` — Server setup, tool registration, startup health check + auto-GC
9. Build and verify: `npm install && npm run build`
10. `README.md` — Tool documentation

### Phase D: Integration
11. Update `settings.json` — Add `mcp__session-bus__*` to permissions
12. Update `mcp.json.template` — Add session-bus server config
13. Verify end-to-end: start server, publish event, read event

---

## 7. Concurrency Safety

- **Writers**: Atomic via `await fs.promises.writeFile(tmp) + await fs.promises.rename(tmp, final)` — POSIX guarantees. Tmp file created in same directory as target to ensure same filesystem.
- **Readers**: Tolerate ENOENT (file deleted between readdir and read), skip `.tmp` files and unparseable JSON
- **GC**: Independent cleanup, no locks needed. Tolerates ENOENT on already-deleted files.
- **mkdir -p**: Idempotent via `fs.promises.mkdir(path, { recursive: true })`
- **Metadata updates**: Atomic read-modify-write via tmp+rename. Single-threaded Node.js + one MCP server process per Claude Code session = no concurrent writes within a process.
- **Sequence counters**: In-memory per-session Map. Rebuilt from file listing on server startup (parse highest sequence from existing event filenames). Safe in single-threaded Node.js.

---

## 8. Error Handling

### Error Codes

```typescript
export const BusErrorCode = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  WRITE_FAILED: "WRITE_FAILED",
  CORRUPT_DATA: "CORRUPT_DATA",
  INVALID_SESSION_ID: "INVALID_SESSION_ID",
  INVALID_EVENT_TYPE: "INVALID_EVENT_TYPE",
  DIR_NOT_WRITABLE: "DIR_NOT_WRITABLE",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;
```

### Error Handling Strategy

- **Corrupt metadata.json**: `list_sessions` skips and warns; `get_session` returns CORRUPT_DATA error; `update_session` recreates from scratch with available data
- **Disk full (ENOSPC)**: `publish` returns WRITE_FAILED error with diagnostic message
- **Permission denied**: Health check on startup warns; tools return DIR_NOT_WRITABLE
- **Missing session directory**: `read_events` returns empty array; `get_session` returns SESSION_NOT_FOUND
- **Invalid session ID**: Validated on input (alphanumeric + hyphens, max 128 chars)

---

## 9. Backward Compatibility

- **Bus is optional**: If MCP server not running, existing workflows continue unchanged
- **Phase completion hook**: Continues writing to `/tmp/claude-phase-complete-*.json` (no changes in v1)
- **Dashboard**: Continues reading legacy signal files (future: add bus query)
- **spawn-worker**: No changes in v1 (future: add `session_bus_register_session` call)
- **No breaking changes**: This is a new, additive component

---

## 10. Configuration

### MCP Server Registration (`~/.claude.json`)

```json
{
  "mcpServers": {
    "session-bus": {
      "command": "node",
      "args": ["/Users/azz/.claude/mcp-servers/session-bus/build/index.js"],
      "env": {
        "SESSION_BUS_DIR": "/Users/azz/.claude/session-bus"
      }
    }
  }
}
```

### Permission Allowlist (`settings.json`)

```json
{
  "permissions": {
    "allow": [
      "mcp__session-bus__*"
    ]
  }
}
```

### Auto-GC on Startup

On server start, run GC with `max_age_hours=168` (7 days), `dry_run=false`, targeting all terminal sessions. Log results to stderr.

---

## 11. Testing Strategy

### Manual Testing (MCP tool calls)
1. Health check → verify bus is operational
2. Register a session → verify metadata.json created
3. Publish 3 events → verify event files created with correct naming + ordering
4. Read events with no filter → all 3 returned in order
5. Read events with `since` filter → subset returned
6. Read events with `event_types` filter → subset returned
7. List sessions → registered session appears
8. Update session status → metadata updated
9. Publish to unregistered session → auto-register creates minimal metadata
10. GC with dry_run → reports what would be deleted
11. GC without dry_run → old events cleaned up
12. Error cases: nonexistent session, invalid event type, corrupt metadata

---

## 12. Future Enhancements (NOT in v1)

- **Hook integration**: Update phase-completion-hook to write to bus directory
- **Spawn integration**: Add `session_bus_register_session` to /spawn-worker
- **Dashboard integration**: Query bus instead of parsing signal files
- **File watching**: `fs.watch` for real-time event notification (vs polling)
- **Subscription tool**: `session_bus_subscribe` for live event streaming
- **Cross-session queries**: "Find all blocked sessions across all coordinators"
- **Metrics**: Event throughput, session duration, phase timing
- **Extended metadata**: `tmux_session`, `trello_card_url`, `remaining_splits`, `start_phase`, `mode`

---

## 13. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Disk bloat from orphaned events | Low | Low | Auto-GC on startup + manual GC tool |
| MCP server crash loses in-memory sequences | Medium | Low | Rebuild from file listing on restart |
| Concurrent metadata.json writes | Very Low | Low | Atomic read-modify-write; single-threaded + one process per session |
| Corrupt metadata from crash mid-write | Low | Low | Atomic tmp+rename; readers skip corrupt files |
| Event ordering across sessions | N/A | N/A | Per-session ordering only (by design) |
| Performance with many events | Low | Low | ~10KB per session, negligible |

---

## Appendix: Comparison with Existing Patterns

| Aspect | Phase Completion Hook | Session Bus MCP |
|--------|----------------------|-----------------|
| Trigger | Automatic (Stop hook) | Explicit (tool call) |
| Direction | Worker → file system | Any session → any session |
| Event types | 1 (phase complete) | 9 structured types |
| Registration | None | Explicit session registration |
| Querying | File glob | Filtered MCP tool calls |
| Lifecycle | Single file overwritten | Append-only event history |
| GC | None (OS cleans /tmp) | Auto-GC on startup + manual tool |
| Error handling | Silent (exit 0) | Typed error codes |

## Appendix: Expert Review Changes

Changes made based on Phase 3b expert review:

1. **Timestamp format**: Changed from `process.hrtime()` microseconds to `Date.now()` milliseconds. hrtime is relative to process start, not wall clock — breaks monotonicity across restarts.
2. **SessionMetadata simplified**: Removed `tmux_session`, `trello_card_id/url`, `remaining_splits`, `start_phase`, `current_phase`, `mode`. These are orchestration concerns, not bus concerns. Can be passed in event payloads.
3. **Error codes added**: `BusErrorCode` enum with SESSION_NOT_FOUND, WRITE_FAILED, CORRUPT_DATA, etc.
4. **Health check tool added**: `session_bus_health` for operational verification.
5. **Auto-GC on startup**: Server runs GC on start with 7-day default.
6. **Sequence counter rebuild**: Explicitly documented: rebuilt from file listing on restart.
7. **Atomic write clarified**: Must use `await fs.promises.*` (not sync variants). Tmp file in same directory as target.
8. **Auto-register clarified**: `publish()` to unregistered session creates minimal metadata (session_id + status + timestamps only, no other fields).
