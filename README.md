# Claude Code Multi-Agent Orchestration

Autonomous worker system for Claude Code. Spawn isolated workers that research, plan, implement, and verify features — while you review plans and test output.

Two management modes:
- **Dispatcher** (production) — a Claude Code session that manages everything via chat
- **Coordinator daemon** (experimental) — a headless Node.js daemon with a `coord` CLI

Both use the same worker model: git worktrees, tmux sessions, Phase 1-5 workflow, human approval gates.

---

## Installation

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated
- Node.js >= 18
- tmux
- git
- iTerm2 (optional — auto-opens tabs for workers)

### 1. Clone this repo as `~/.claude`

```bash
git clone git@github.com:avovsya/claude_settings.git ~/.claude
```

If you already have `~/.claude`, back it up first. Claude Code loads `~/.claude/CLAUDE.md` as global instructions for every session.

### 2. Configure MCP servers

```bash
cp ~/.claude/mcp.json.template ~/.claude/mcp.json
```

Edit `~/.claude/mcp.json` and fill in your credentials:

| Server | Required for | How to get credentials |
|--------|-------------|----------------------|
| **Trello MCP** | Dispatcher + Coordinator | [Trello Power-Up API key](https://trello.com/power-ups/admin) — set `TRELLO_API_KEY` and `TRELLO_TOKEN` |
| **Session-bus MCP** | Worker-to-coordinator communication | No credentials — just set the path to `mcp-servers/session-bus/build/index.js` |
| **tmux-control MCP** | Dispatcher tmux operations | No credentials — just set the path to `mcp-servers/tmux-control/build/index.js` |

### 3. Build MCP servers

```bash
cd ~/.claude/mcp-servers/session-bus && npm install && npm run build
cd ~/.claude/mcp-servers/tmux-control && npm install && npm run build
```

### 4. Build coordinator daemon (optional)

Only needed if you want to use the `coord` CLI instead of the Dispatcher.

```bash
cd ~/.claude/coordinator && npm install && npm run build && npm link
```

This puts `coord` and `coordinator` on your PATH.

### 5. Verify

```bash
claude --version          # Claude Code CLI
tmux -V                   # tmux
coord status 2>/dev/null  # coordinator (if installed)
```

---

## Dispatcher Workflow (Production)

The Dispatcher is a normal Claude Code session with the global `CLAUDE.md` loaded. It manages Trello cards, creates worktrees, spawns workers, monitors progress, and handles merges. It never writes implementation code.

### Start a Dispatcher

```bash
cd ~/.claude       # or any git repo
claude             # this session is now your Dispatcher
```

### Spawn a worker from a Trello card

```
> work on <card-name>
> /spawn-worker <card-name-or-url> [--splits N] [--phase N]
> /spawn-worker next                # picks first P1-Critical from To Do
```

What happens behind the scenes:
1. Finds the Trello card (handles fuzzy matching, multiple results)
2. Checks card state (already in progress? done?)
3. Verifies git is clean
4. Creates branch (`feature/`, `fix/`, `refactor/`, or `docs/` prefix based on labels)
5. Creates git worktree
6. Copies submodules (auto-detected from `.gitmodules`)
7. Moves Trello card to "Implementing" (or "Researching" for Curiosity Lab board)
8. Creates tmux session (2 panes: 70% Claude / 30% shell)
9. Writes worker prompt to `/tmp/` and launches Claude with `--dangerously-skip-permissions`
10. Opens iTerm2 tab attached to the tmux session

### Spawn an ad-hoc worker (no Trello card)

```
> /adhoc "refactor the auth module"
> /adhoc "research how MCP servers handle auth" --splits 1
> /adhoc "implement the new parser" --phase 4
```

Same as `/spawn-worker` but skips Trello entirely. Good for experiments and quick tasks.

**Options:**
- `--splits N` (default: 0) — how many times the worker can split into sub-workers. 0 = must complete in one session.
- `--phase N` (default: 1) — which phase to start at. 1=Research, 2=Cross-Cutting, 3=Planning, 4=Implementation, 5=Verification.

### Monitor workers

```
> wip                    # dashboard of all active tasks
> check on the worker    # reads the tmux pane to see what's happening
```

The `wip` dashboard shows:

| Task | Priority | tmux | Branch | Phase | Build | Last Activity | Health |
|------|----------|------|--------|-------|-------|---------------|--------|

### Approve a plan

Workers pause at Phase 3b with an implementation plan. Attach to the worker's tmux session and review:

```bash
tmux attach -t <session-name>
# Read the plan, then:
> looks good, proceed
> change X to Y           # request changes
```

### Finish a task (merge + cleanup)

```
> finish task             # or: review and merge
```

The Dispatcher: verifies build, merges to main (`--no-ff`), updates Trello, removes worktree + branch + tmux session.

### Recover a crashed worker

```
> recover task <name>     # or: resume task <name>
```

Finds the worktree, recreates tmux if needed, runs `claude --continue`.

### Other commands

```
> i'm bored              # suggests interesting tasks from the backlog
> curio <topic>           # creates a research card on the Curiosity Lab board
```

---

## Coordinator Daemon (Experimental)

The coordinator is a headless Node.js daemon that replaces the Dispatcher session. It runs without an LLM in its poll loop — it monitors workers via session-bus events, manages approvals via the `coord` CLI, and handles merges and cleanup.

### How it differs from the Dispatcher

| Aspect | Dispatcher | Coordinator |
|--------|-----------|-------------|
| Technology | Claude Code session (LLM) | Node.js daemon (no LLM) |
| Runs in | Terminal (foreground, interactive) | Background (launchd or manual) |
| Spawning | `/spawn-worker` in chat | `coord spawn <card-name>` |
| Monitoring | `wip` in chat | `coord status` |
| Approvals | "looks good" in the worker tmux | `coord approve [session-id]` |
| Crash recovery | `claude --continue` | Auto-restart via launchd `KeepAlive` |
| Trello | Via Trello MCP (built-in) | Via Trello REST API (needs `TRELLO_API_KEY` + `TRELLO_TOKEN` env vars) |

### Start the daemon

```bash
# Manual (foreground)
node ~/.claude/coordinator/build/index.js --main-worktree /path/to/your/repo

# Or with env vars for Trello integration
TRELLO_API_KEY=your-key TRELLO_TOKEN=your-token \
  node ~/.claude/coordinator/build/index.js --main-worktree ~/.claude

# With logging
node ~/.claude/coordinator/build/index.js --main-worktree ~/.claude --log-level debug
```

### Auto-start with launchd

Edit `coordinator/com.coordinator.agent.plist` — replace placeholder paths:

| Placeholder | Replace with |
|-------------|-------------|
| `COORDINATOR_BUILD_DIR` | `~/.claude/coordinator/build` (expand `~`) |
| `MAIN_WORKTREE_PATH` | Your main repo path |
| `LOG_DIR` | `~/.claude/coordinator/logs` (expand `~`) |
| `HOME_DIR` | Your home directory |

Then:

```bash
cp ~/.claude/coordinator/com.coordinator.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.coordinator.agent.plist
```

### CLI commands

```bash
coord status                            # Dashboard: workers, approvals, merge queue
coord list                              # Pending approvals
coord approve [session-id]              # Approve plan or merge
coord approve [session-id] --changes "feedback"  # Approve with feedback
coord reject <session-id> "reason"      # Reject with reason
coord spawn <card-name>                 # Request worker spawn via Trello
coord logs <session-id>                 # Session-bus events for a worker
coord stop                              # Graceful shutdown
```

### State and data

| Store | Location | Purpose |
|-------|----------|---------|
| SQLite DB | `coordinator/coordinator.db` | Worker registry, approvals, merge queue |
| Session-bus | `~/.claude/session-bus/` | Worker events (file-based pub/sub) |
| Logs | `coordinator/logs/` | JSON-structured daemon logs |

### Dependencies

The coordinator daemon requires these components:

| Component | Location | Purpose |
|-----------|----------|---------|
| **Session-bus MCP** | `mcp-servers/session-bus/` | Workers publish events here; coordinator reads them |
| **tmux-control MCP** | `mcp-servers/tmux-control/` | Type-safe tmux operations for the Dispatcher (create sessions, capture panes, detect prompts, launch Claude) |
| **Trello REST API** | Built into `coordinator/src/trello-client.ts` | Card lookup, move, description updates |
| **tmux** | System | Worker session management |
| **git** | System | Worktree and branch management |

The session-bus MCP server must be built and configured in `mcp.json` for workers to publish events. The coordinator reads the session-bus files directly (not via MCP).

---

## Worker Model

Every worker follows the same recursive structure regardless of whether it was spawned by the Dispatcher or the Coordinator.

### Phase 1-5 Workflow

```
Phase 1: Deep Research         — parallel sub-agents read code, docs, patterns
Phase 2: Cross-Cutting Analysis — thread safety, state flow, dependencies
  → Context Capacity Check     — can this fit in one context?
Phase 3a: Draft Plan           — writes Plans/PLAN_<NAME>.md
Phase 3b: Expert Review Panel  — critic agents review the plan
  → STOP: wait for human approval
Phase 4: Implementation        — sequential, build after each major part
Phase 5: Verification          — review agents check correctness
  → Finish: build, commit, completion report
```

### Splitting (recursive workers)

If a task is too large for one context, a worker with `remaining_splits > 0` becomes a Coordinator: it decomposes the task into phases and spawns child workers. Each child gets `remaining_splits - 1`.

```
Dispatcher (spawns with splits=2)
  └── Worker A [splits=2] — small task, completes as Implementer
  └── Worker B [splits=2] — too large, becomes Coordinator
        └── Worker B.1 [splits=1] — Phase 1 child
        └── Worker B.2 [splits=1] — Phase 2 child
        └── Worker B.3 [splits=1] — still too large, splits again
              └── Worker B.3a [splits=0] — LEAF, must complete
              └── Worker B.3b [splits=0] — LEAF, must complete
```

Workers with `splits=0` are leaves — they must complete in one context or commit WIP and stop.

### Permission model

Workers run with `--dangerously-skip-permissions` for zero friction. This is safe because:
- Each worker runs in an isolated git worktree on a feature branch
- Workers cannot push to remote or merge to main
- Only the Dispatcher/Coordinator merges (after reviewing diffs)
- Claude has built-in safety constraints regardless of permission settings

---

## tmux Quick Reference

| Command | Action |
|---------|--------|
| `tmux ls` | List all sessions |
| `tmux attach -t <name>` | Attach to a worker |
| `Ctrl-b d` | Detach |
| `Ctrl-b Up` / `Ctrl-b Down` | Switch panes |
| `Ctrl-b z` | Zoom pane (toggle) |
| `tmux kill-session -t <name>` | Kill session |

Worker layout: top pane (70%) = Claude Code, bottom pane (30%) = shell for building/testing.

---

## File Map

| Path | Purpose |
|------|---------|
| `CLAUDE.md` | Global agent instructions — loaded into every Claude session |
| `CHEATSHEET.md` | Human-readable workflow guide with examples |
| `README.md` | This file — installation and usage |
| `settings.json` | Global Claude Code settings (permissions, hooks) |
| `mcp.json` | Active MCP server config (**not committed** — contains secrets) |
| `mcp.json.template` | MCP config template (committed, secrets redacted) |
| `coordinator/` | Coordinator daemon (Node.js) |
| `coordinator/com.coordinator.agent.plist` | launchd plist template |
| `mcp-servers/session-bus/` | Session-bus MCP server (inter-session messaging) |
| `mcp-servers/tmux-control/` | tmux-control MCP server (type-safe tmux operations for Dispatcher) |
| `skills/spawn-worker/` | `/spawn-worker` skill definition |
| `skills/adhoc/` | `/adhoc` skill definition |
| `hooks/` | Claude Code hooks (phase completion, pre-compact metrics) |
| `rules/` | Persistent rules that survive context compression |
| `plans/` | Implementation plans and research findings |

## Secrets

**Never commit `mcp.json`** — it contains API keys. Only `mcp.json.template` is tracked. The `.gitignore` uses a deny-by-default allowlist, so new files are ignored automatically unless explicitly allowlisted.
