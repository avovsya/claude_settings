# Claude Code Multi-Agent Orchestration

Autonomous worker system for Claude Code. Spawn isolated workers that research, plan, implement, and verify features — while you review plans and test output.

The Dispatcher is a Claude Code session that manages everything via chat: Trello cards, git worktrees, tmux sessions, Phase 1-5 workflow, and human approval gates. Workers can use Claude or the OpenAI Codex CLI.

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
| **Trello MCP** | Dispatcher + Codex worker | [Trello Power-Up API key](https://trello.com/power-ups/admin) — set `TRELLO_API_KEY` and `TRELLO_TOKEN` |
| **Session-bus MCP** | Inter-session worker events | No credentials — just set the path to `mcp-servers/session-bus/build/index.js` |
| **tmux-control MCP** | Dispatcher tmux operations | No credentials — just set the path to `mcp-servers/tmux-control/build/index.js` |

### 3. Build MCP servers

```bash
cd ~/.claude/mcp-servers/session-bus && npm install && npm run build
cd ~/.claude/mcp-servers/tmux-control && npm install && npm run build
```

### 4. Verify

```bash
claude --version   # Claude Code CLI
tmux -V            # tmux
codex --version    # OpenAI Codex CLI (optional — only needed for /codex-worker)
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

### Spawn a Codex worker

```
> /codex-worker <card-name-or-url>
> spawn codex for <card-name>
```

Same worktree + tmux setup as `/spawn-worker` but launches the OpenAI Codex CLI instead of Claude. Requires `codex` on PATH.

### When to use which

| Scenario | Skill | Why |
|----------|-------|-----|
| Single task, Claude | `/spawn-worker` | Full Claude session with phase workflow |
| Ad-hoc task, no Trello card | `/adhoc` | Lightweight, no Trello |
| Task using OpenAI Codex CLI | `/codex-worker` | Launches `codex` instead of `claude` |

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
| `coordinator/` | Node.js coordinator daemon (archived — not actively used) |
| `mcp-servers/session-bus/` | Session-bus MCP server (inter-session messaging) |
| `mcp-servers/tmux-control/` | tmux-control MCP server (type-safe tmux operations for Dispatcher) |
| `skills/spawn-worker/` | `/spawn-worker` skill — Claude worker for Trello cards |
| `skills/adhoc/` | `/adhoc` skill — Claude worker without Trello |
| `skills/codex-worker/` | `/codex-worker` skill — OpenAI Codex CLI worker for Trello cards |
| `hooks/` | Claude Code hooks (phase completion, pre-compact metrics) |
| `rules/` | Persistent rules that survive context compression |
| `plans/` | Implementation plans and research findings |

## Secrets

**Never commit `mcp.json`** — it contains API keys. Only `mcp.json.template` is tracked. The `.gitignore` uses a deny-by-default allowlist, so new files are ignored automatically unless explicitly allowlisted.
