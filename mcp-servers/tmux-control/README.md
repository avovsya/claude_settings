# tmux-control MCP Server

Type-safe MCP server wrapping tmux operations for Claude Code. Eliminates shell escaping fragility and provides tmux operations as proper tools instead of fragile Bash calls.

## Setup

### 1. Build

```bash
cd mcp-servers/tmux-control
npm install
npm run build
```

### 2. Register in `~/.claude/mcp.json`

```json
{
  "mcpServers": {
    "tmux-control": {
      "command": "node",
      "args": ["/path/to/mcp-servers/tmux-control/build/index.js"]
    }
  }
}
```

### 3. Add permission in `~/.claude/settings.json`

```json
{
  "permissions": {
    "allow": [
      "mcp__tmux-control__*"
    ]
  }
}
```

### 4. Restart Claude Code

MCP servers are discovered on startup. After configuration changes, restart Claude Code.

## Tools

### Core Tools

#### `tmux_create_session`
Create a named tmux session with an optional working directory.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Session name (`^[a-z0-9][a-z0-9-]*$`, max 64 chars) |
| `cwd` | string | no | Working directory (must exist) |

#### `tmux_kill_session`
Destroy a tmux session and all its windows/panes.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Session name to destroy |

#### `tmux_list_sessions`
List all active tmux sessions. No parameters. Returns JSON array with session name, window count, created time, attached status, and size.

#### `tmux_split_window`
Split a tmux window into a new pane.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `direction` | "horizontal" \| "vertical" | no | Split direction (default: vertical) |
| `percent` | number (1-99) | no | Size of new pane (default: 30) |
| `cwd` | string | no | Working directory for new pane |

#### `tmux_send_keys`
Send keystrokes to a tmux pane.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `text` | string | yes | Text to send |
| `enter` | boolean | no | Press Enter after (default: true) |
| `literal` | boolean | no | Send literally with `-l` (default: true) |

> **Warning:** Sending Enter to Claude Code's text input field is unreliable via tmux — text is added but NOT submitted. Use `tmux_launch_claude` with `prompt_file` instead.

#### `tmux_capture_pane`
Read recent output from a tmux pane.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `lines` | number (1-10000) | no | History lines to capture (default: 50) |

### Bonus Tools

#### `tmux_detect_prompt_type`
Parse pane output to identify Claude Code session state.

Returns `{ state, confidence, last_lines }` where state is one of:
- `plan_mode` — Claude is in plan mode
- `edit_acceptance` — File edit shown, awaiting accept/reject
- `permission_prompt` — Permission prompt with options
- `idle` — Waiting for input (`>` prompt)
- `processing` — Actively generating/running
- `unknown` — Cannot determine

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |

#### `tmux_approve_permission`
Approve a permission prompt in a Claude Code session. Verifies prompt exists before sending approval.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `option` | number (0-20) | no | Option number to select (default: Enter) |

#### `tmux_interrupt`
Send Escape and/or Ctrl-C to unstick workers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `signal` | "escape" \| "ctrl-c" \| "both" | no | What to send (default: "both") |

#### `tmux_launch_claude`
Launch Claude Code in a tmux pane. Handles `unset CLAUDECODE &&` internally to prevent environment leakage.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `prompt_file` | string | no | Path to prompt file (most reliable) |
| `continue_session` | boolean | no | Use `--continue` flag |
| `resume` | string | no | Session ID for `--resume` |

## Error Handling

All tools return structured errors with an error code prefix:

| Code | Meaning |
|------|---------|
| `SESSION_NOT_FOUND` | Session doesn't exist |
| `TARGET_NOT_FOUND` | Pane or window doesn't exist |
| `SESSION_EXISTS` | Session name already in use |
| `SERVER_NOT_RUNNING` | tmux server not running |
| `TMUX_NOT_INSTALLED` | tmux binary not in PATH |
| `TMUX_TIMEOUT` | Operation timed out (10s limit) |
| `INVALID_SESSION_NAME` | Name doesn't match `^[a-z0-9][a-z0-9-]*$` |
| `INVALID_PATH` | Directory doesn't exist |
| `FILE_NOT_FOUND` | File not found or not readable |

## Session Naming Rules

Session names must:
- Start with a lowercase letter or digit
- Contain only lowercase letters, digits, and hyphens
- Be at most 64 characters

Names with `.` or `:` are **rejected** (not silently rewritten) because tmux interprets these as pane/window separators, causing targeting failures.

## Examples

### Create a worker session
```
tmux_create_session({ name: "feature-auth", cwd: "/path/to/worktree" })
tmux_split_window({ session: "feature-auth", direction: "vertical", percent: 30 })
tmux_launch_claude({ session: "feature-auth", pane: 1, prompt_file: "/tmp/feature-auth-prompt.md" })
```

### Monitor a worker
```
tmux_capture_pane({ session: "feature-auth", pane: 1, lines: 50 })
tmux_detect_prompt_type({ session: "feature-auth", pane: 1 })
```

### Approve a permission prompt
```
tmux_approve_permission({ session: "feature-auth", pane: 1 })
```

## Known Limitations

1. **Enter unreliability:** `send_keys` with Enter does not submit Claude Code's text input. Use `launch_claude` with `prompt_file` instead.
2. **Processing vs stuck:** `detect_prompt_type` cannot distinguish "processing" from "stuck" with a single capture. Take two captures and compare.
3. **Parallel send_keys:** Concurrent `send_keys` to the same pane may interleave unpredictably.
4. **Capture limit:** `capture_pane` output is bounded by tmux's `history_limit` (default 2000 lines) and tool max of 10000 lines.

## Architecture

```
src/
├── index.ts        # Server entry, tool registration
├── tmux.ts         # execTmux(), validation, error parsing
├── types.ts        # Error codes, types, constants
└── tools/
    ├── sessions.ts # create_session, kill_session, list_sessions
    ├── panes.ts    # split_window, send_keys, capture_pane
    ├── detection.ts # detect_prompt_type
    └── claude.ts   # launch_claude, approve_permission, interrupt
```

All tmux commands executed via `execFile` (not `exec`) with argument arrays — no shell interpretation. 10-second timeout on all operations. Commands logged to stderr for debugging.
