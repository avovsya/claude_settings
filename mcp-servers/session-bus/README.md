# Session Bus MCP Server

File-based pub/sub messaging between Claude Code sessions. Workers publish structured events (phase completions, errors, blockers), and coordinators/dispatchers poll for them — eliminating the human as the sole message bus.

## Architecture

```
~/.claude/session-bus/
└── sessions/
    └── {session_id}/
        ├── metadata.json                          # Session registration + status
        ├── 1708915234567-00000-session_started.json
        ├── 1708915240000-00001-phase_complete.json
        └── 1708915250000-00002-build_result.json
```

- **File-based**: All state persisted as JSON files (survives restarts, debuggable with `ls`/`cat`/`jq`)
- **Lock-free**: Atomic writes via tmp+rename, per-session isolation
- **Optional**: Existing workflows continue unchanged if bus is unavailable

## Installation

```bash
cd mcp-servers/session-bus
npm install
npm run build
```

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "session-bus": {
      "command": "node",
      "args": ["/path/to/mcp-servers/session-bus/build/index.js"]
    }
  }
}
```

The base directory defaults to `~/.claude/session-bus/`. Override with the `SESSION_BUS_DIR` environment variable.

## Tools

### `session_bus_publish`

Publish an event from the current session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Publishing session's ID |
| `event_type` | string | Yes | One of the event types below |
| `data` | object | Yes | Event-specific payload |

Auto-registers the session if not already registered.

**Event types:**

| Type | When | Typical payload |
|------|------|-----------------|
| `phase_complete` | Worker finished a phase | `{ phase: 2, status: "completed" }` |
| `plan_ready` | Plan written, awaiting approval | `{ plan_path: "Plans/PLAN_FOO.md" }` |
| `blocked` | Worker stuck | `{ reason: "...", blocker_type: "dependency" }` |
| `error` | Worker encountered error | `{ message: "...", recoverable: true }` |
| `wip_committed` | Worker committed checkpoint | `{ commit: "abc123", phase: 3 }` |
| `split_requested` | Worker wants to split | `{ planned_phases: 3, reason: "..." }` |
| `build_result` | Build succeeded/failed | `{ passed: true }` |
| `session_started` | Session began executing | `{ mode: "implementer" }` |
| `context_warning` | Context getting low | `{ compaction_count: 2 }` |

### `session_bus_read_events`

Read events published by a session with optional filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Session to read events from |
| `event_types` | string[] | No | Filter by event type(s) |
| `since` | string | No | ISO 8601 timestamp — only events after this |
| `last_n` | number | No | Return only the last N events |

Returns `{ events: [...], count: N }` in chronological order.

### `session_bus_register_session`

Explicitly register a session with metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Unique session identifier |
| `branch` | string | No | Git branch name |
| `worktree` | string | No | Absolute worktree path |
| `parent_session_id` | string | No | Parent coordinator session ID |

If already registered, merges new fields without overwriting existing values. Publishes an implicit `session_started` event.

### `session_bus_get_session`

Get metadata for a specific session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Session ID to look up |

### `session_bus_update_session`

Update session status or metadata. Setting a terminal status (`completed`, `partial`, `blocked`, `dead`) also sets `completed_at`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | Yes | Session to update |
| `status` | string | No | New status |
| `commit` | string | No | Commit hash |
| `branch` | string | No | Git branch |
| `worktree` | string | No | Worktree path |

**Session statuses:** `active`, `idle`, `completed`, `partial`, `blocked`, `dead`

### `session_bus_list_sessions`

List all registered sessions, sorted by most recently updated first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status |
| `parent_session_id` | string | No | Filter by parent (find children of a coordinator) |

### `session_bus_garbage_collect`

Clean up old sessions and events.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `max_age_hours` | number | No | Delete items older than N hours (default: 168 = 7 days) |
| `dry_run` | boolean | No | Preview without deleting (default: false) |
| `status` | string | No | Only clean sessions with this status |

Terminal sessions older than `max_age_hours` are deleted entirely. Active sessions only have old events pruned.

### `session_bus_health`

Check if the bus is operational. Returns `{ ok, base_dir, session_count, writable }`.

## Startup Behavior

On startup, the server:
1. Ensures the base directory exists and is writable
2. Rebuilds in-memory sequence counters from existing event files
3. Runs auto-GC (deletes terminal sessions older than 7 days)
4. Reports health status to stderr

## Debugging

```bash
# List all sessions
ls ~/.claude/session-bus/sessions/

# Read a session's metadata
cat ~/.claude/session-bus/sessions/SESSION_ID/metadata.json

# List events for a session
ls -la ~/.claude/session-bus/sessions/SESSION_ID/

# Read a specific event
cat ~/.claude/session-bus/sessions/SESSION_ID/1708915234567-00001-phase_complete.json

# Count events per session
for d in ~/.claude/session-bus/sessions/*/; do
  echo "$(basename $d): $(ls "$d"/*.json 2>/dev/null | grep -v metadata | wc -l) events"
done
```
