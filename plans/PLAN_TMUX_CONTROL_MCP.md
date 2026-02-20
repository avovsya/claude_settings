# Plan: Tmux Control MCP Server

**Status:** IMPLEMENTED (2026-02-20)
**Branch:** feature/tmux-control-mcp
**Trello:** https://trello.com/c/bpf5fqN8/4-6-tmux-control-mcp-server

---

## Architecture

### Overview

A Node.js MCP server using `@modelcontextprotocol/sdk` that wraps tmux operations as type-safe tools. Communicates via stdio transport, registered globally in `~/.claude/mcp.json`.

### Project Structure

```
mcp-servers/tmux-control/
├── src/
│   ├── index.ts           # Server entry point, tool registration
│   ├── tmux.ts            # Low-level tmux command execution + error normalization
│   ├── tools/
│   │   ├── sessions.ts    # create_session, kill_session, list_sessions
│   │   ├── panes.ts       # split_window, send_keys, capture_pane
│   │   ├── detection.ts   # detect_prompt_type
│   │   └── claude.ts      # launch_claude, approve_permission, interrupt
│   └── types.ts           # Shared types and error codes
├── package.json
├── tsconfig.json
├── README.md
└── .gitignore
```

### Design Decisions

1. **Stdio transport** — Standard for local MCP servers; matches Trello MCP pattern
2. **Global registration** — Tmux is a system utility, not project-specific
3. **Zod schemas** — Type-safe input validation, auto-generates JSON Schema for MCP
4. **Thin tool layer** — Tools validate input + call `tmux.ts` executor + format results
5. **Centralized tmux executor** — Single `execTmux()` function using `execFile` (not `exec`) with argument arrays to prevent shell injection. Includes 10-second timeout, error parsing, and normalization
6. **Session name sanitization** — Validate names match `^[a-z0-9][a-z0-9-]*$` (reject invalid chars rather than silently rewriting). Max 64 chars
7. **Working directory validation** — Resolve to absolute path and check existence before passing `-c` to tmux (tmux silently falls back to `$HOME`)
8. **Command logging** — All tmux commands logged to stderr for debugging

---

## Tool Specifications

### Core Tools

#### 1. `tmux_create_session`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Session name (must match `^[a-z0-9][a-z0-9-]*$`, max 64 chars) |
| `cwd` | string | no | Working directory (resolved to absolute path, validated) |

Returns: Session name (post-sanitization), window/pane info.

#### 2. `tmux_split_window`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `direction` | "horizontal" \| "vertical" | no | Split direction (default: vertical) |
| `percent` | number | no | Size of new pane as percentage (default: 30) |
| `cwd` | string | no | Working directory for new pane |

Returns: New pane ID/index.

#### 3. `tmux_send_keys`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `text` | string | yes | Text to send |
| `enter` | boolean | no | Press Enter after text (default: true) |
| `literal` | boolean | no | Send text literally with `-l` flag (default: true) |

**Note in description:** Sending Enter to Claude Code's text input field is unreliable — text is added but not submitted. This is a known tmux limitation.

Returns: Confirmation of send.

#### 4. `tmux_capture_pane`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `lines` | number | no | Number of history lines to capture (default: 50, max: 10000) |

Returns: Captured text output.

#### 5. `tmux_kill_session`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Session name to destroy |

Returns: Confirmation.

#### 6. `tmux_list_sessions`
No parameters.

Returns: Array of sessions with name, window count, created time, attached status, size.

### Bonus Tools

#### 7. `tmux_detect_prompt_type`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |

Detection priority (highest specificity first):
1. **plan_mode** — `Plan mode` keywords
2. **edit_acceptance** — Diff markers (`+++ / ---`) + approval question
3. **permission_prompt** — `Allow` keyword + numbered options or `[y/n]`
4. **idle** — Last non-empty line is `>` prompt
5. **processing** — Default/fallback when no other pattern matches

Returns: `{ state, confidence, last_lines }`. Known limitation: single capture cannot reliably distinguish "processing" from "stuck".

#### 8. `tmux_approve_permission`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `option` | number | no | Option number to select (default: send Enter for first/highlighted) |

Shortcut: captures pane to verify permission prompt exists, then sends Enter (or option number + Enter).

#### 9. `tmux_interrupt`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `signal` | "escape" \| "ctrl-c" \| "both" | no | What to send (default: "both") |

Sends Escape then Ctrl-C (or one of them) to unstick workers.

#### 10. `tmux_launch_claude`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Target session name |
| `pane` | number | no | Pane index (default: 0) |
| `prompt_file` | string | no | Path to prompt file (sent via `cat <file> \| claude`) |
| `continue` | boolean | no | Use `--continue` flag |
| `resume` | string | no | Session ID for `--resume` |

Internally prepends `unset CLAUDECODE &&` to the command. Validates prompt file exists if provided.

---

## Error Handling

### tmux Error Normalization

All tmux errors parsed from stderr into structured types:

| stderr Pattern | Error Type | Description |
|----------------|------------|-------------|
| `can't find session: X` | `SESSION_NOT_FOUND` | Session doesn't exist |
| `can't find pane: X` | `TARGET_NOT_FOUND` | Pane doesn't exist |
| `can't find window: X` | `TARGET_NOT_FOUND` | Window doesn't exist |
| `duplicate session: X` | `SESSION_EXISTS` | Session already exists |
| `error connecting to` | `SERVER_NOT_RUNNING` | tmux server not running |
| Exit code 127 | `TMUX_NOT_INSTALLED` | tmux binary not found |

Error responses use MCP's `isError: true` with descriptive message.

### Subprocess Execution

- All tmux commands executed via `execFile` (not `exec`) with argument arrays — no shell interpretation
- 10-second timeout on all operations; returns `TMUX_TIMEOUT` on expiry
- All commands logged to stderr: `[tmux-control] exec: tmux new-session -d -s foo`
- File existence checks via `fs.accessSync` before any path-dependent operations

### Startup Health Check

On server initialization:
1. Verify `tmux` binary exists (`which tmux`)
2. Log tmux version to stderr
3. If tmux missing, tools return `TMUX_NOT_INSTALLED` error on each call

---

## Implementation Phases

### Phase A: Project Scaffold + Core tmux Executor (files: package.json, tsconfig.json, src/types.ts, src/tmux.ts, src/index.ts)

1. Create `mcp-servers/tmux-control/` directory structure
2. Write `package.json` with dependencies (`@modelcontextprotocol/sdk`, `zod`)
3. Write `tsconfig.json` (ES2022, Node16 module)
4. Implement `src/types.ts` — error codes, result types
5. Implement `src/tmux.ts` — `execTmux()` function with error parsing, session name sanitization, directory validation
6. Scaffold `src/index.ts` — McpServer instance + stdio transport
7. `npm install && npm run build` — verify compilation

### Phase B: Core Tools (files: src/tools/sessions.ts, src/tools/panes.ts, src/index.ts)

1. Implement `tmux_create_session` — sanitize name, validate cwd, create session
2. Implement `tmux_kill_session` — verify session exists, kill
3. Implement `tmux_list_sessions` — parse `tmux list-sessions -F` format string output
4. Implement `tmux_split_window` — validate session, split with direction/percent
5. Implement `tmux_send_keys` — validate target, handle literal flag, Enter key
6. Implement `tmux_capture_pane` — validate target, capture with line range
7. Register all tools in `src/index.ts`
8. Build and manual test

### Phase C: Bonus Tools (files: src/tools/detection.ts, src/tools/claude.ts, src/index.ts)

1. Implement `tmux_detect_prompt_type` — capture pane, run regex patterns in priority order, return state + confidence
2. Implement `tmux_approve_permission` — verify prompt, send Enter/option
3. Implement `tmux_interrupt` — send Escape/Ctrl-C sequences
4. Implement `tmux_launch_claude` — build command with `unset CLAUDECODE &&`, validate prompt file, send keys
5. Register bonus tools
6. Build and manual test

### Phase D: Integration + Documentation (files: README.md, .gitignore, ~/.claude/settings.json)

1. Write README.md — setup instructions, tool reference, known limitations
2. Write `.gitignore` — node_modules, build
3. Update `~/.claude/settings.json` — add `mcp__tmux-control__*` permission
4. Document registration for `~/.claude/mcp.json`
5. Final build verification

---

## Testing Strategy

Manual testing during implementation:
- Create/list/kill sessions
- Split windows, send keys, capture output
- Error cases: nonexistent sessions, duplicate names, bad pane targets
- Special characters in session names
- `detect_prompt_type` against a live Claude session
- `launch_claude` with prompt file

---

## Dependencies

- `@modelcontextprotocol/sdk` (latest)
- `zod` (v3.x, peer dependency for MCP SDK)
- Node.js 18+ (ES2022 target, declared in `engines` field)
- TypeScript 5.x (dev dependency)
- `@types/node` (dev dependency)
- Zero runtime dependencies beyond MCP SDK + zod

---

## Known Limitations (to document in README)

1. `send_keys` Enter to Claude Code's text input field is unreliable — text added but not submitted. Use `launch_claude` with `prompt_file` for reliable command execution
2. `detect_prompt_type` cannot reliably distinguish "processing" from "stuck" with a single capture
3. Parallel `send_keys` to the same pane may interleave unpredictably — avoid concurrent calls to same target
4. Session names must match `^[a-z0-9][a-z0-9-]*$` — names with `.`, `:`, spaces, or uppercase are rejected
5. `capture_pane` output bounded by tmux's `history_limit` (default 2000 lines) and tool max of 10000 lines

## Expert Review Notes

**Reviewed by:** Software Architect, Security/Reliability Reviewer

**Incorporated:**
- `execFile` with argument arrays (prevents shell injection)
- 10s timeout on all tmux operations
- Session name validation (reject invalid chars instead of silent rewrite)
- Max bounds on `lines` parameter
- Path resolution and validation
- Command logging to stderr

**Deferred (over-engineering for single-user local tool):**
- Session creation quotas (Claude already has shell access)
- Per-pane mutex locks (MCP is request/response, not concurrent)
- Path whitelisting (Claude already has full filesystem access)
