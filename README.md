# Claude Code Multi-Agent Orchestration

Autonomous worker system for Claude Code. A Dispatcher session manages Trello cards, git worktrees, and tmux sessions — spawning isolated Claude workers that follow a structured Phase 1-5 workflow with human approval gates.

**Used this system to build itself** — 10 cards shipped in one day, including the coordinator daemon, session-bus MCP, tmux MCP, and this workflow.

---

## Quick Start (5 minutes)

### 1. Open a Dispatcher session

```bash
cd /path/to/your/project   # any git repo
claude                      # this is now your Dispatcher
```

### 2. Spawn a worker

```
> work on <trello-card-name>       # from a Trello card
> /spawn-worker <card-name>        # explicit skill invocation
> /adhoc "refactor the auth flow"  # no Trello card needed
```

The Dispatcher creates a git worktree, branch, tmux session, writes a worker prompt, and launches Claude in the tmux pane. An iTerm2 tab opens automatically.

### 3. Watch it work

```
> check on the worker              # Dispatcher reads tmux pane
> wip                              # dashboard of all active tasks
```

Or attach directly: `tmux attach -t <session-name>`

### 4. Approve the plan

Workers stop at Phase 3b and present an implementation plan. In the worker's tmux pane:

```
> looks good, proceed              # approve
> change X to Y                    # request changes
```

### 5. Merge when done

Back in the Dispatcher:

```
> review and merge                 # Dispatcher reviews diff, merges to main
> finish task                      # full cycle: build check, merge, Trello, cleanup
```

---

## What Works Today (Production-Ready)

| Component | Status | How to use |
|-----------|--------|------------|
| **Dispatcher session** | Stable | Any Claude session with `~/.claude/CLAUDE.md` loaded |
| `/spawn-worker` | Stable | `work on <card>` or `/spawn-worker <card> [--splits N] [--phase N]` |
| `/adhoc` | Stable | `/adhoc "task description"` — no Trello card needed |
| `wip` dashboard | Stable | `wip` or `task status` in Dispatcher |
| Worker Phase 1-5 | Stable | Workers follow automatically from CLAUDE.md instructions |
| `--dangerously-skip-permissions` | Stable | Workers run with zero permission prompts |
| Phase completion hook | Active | Writes `/tmp/claude-phase-complete-*.json` on worker stop |
| Structured completion reports | Active | YAML front matter in `COMPLETION_REPORT.md` |

## What's Built but Needs Testing

| Component | Location | Status | What's missing |
|-----------|----------|--------|----------------|
| **Coordinator daemon** | `coordinator/` | Code complete, undeployed | `npm install && npm run build`, then run or set up launchd |
| **Session-bus MCP** | `mcp-servers/session-bus/` | Built, configured in mcp.json | Workers don't publish events yet (prompt template needs update) |
| **Tmux MCP** | [GitHub](https://github.com/avovsya/tmux_mcp_server) | Built, published | Not in `mcp.json` — Dispatcher can't use MCP tmux tools |
| **coord CLI** | `coordinator/src/cli/coord.ts` | Built | Not on PATH — needs `npm link` in coordinator/ |

## What's Not Built Yet

| Gap | Impact | Card |
|-----|--------|------|
| Workers publishing to session-bus | Coordinator can't get events from workers | Needs prompt template update |
| Trello REST in coordinator | Coordinator can't update cards | Deferred in #10 |
| End-to-end integration test | Coordinator + session-bus + workers untested together | — |
| Worker Agent (SDK) | Workers as SDK processes instead of tmux CLI | Card #11 |
| Build automation between phases | Manual build/test between phases | Card #12 |

---

## Architecture

```
You (Human)
  |
  |  "work on X", approve plans, test output
  |
Dispatcher (Claude Code session in main repo)        <-- PRODUCTION
  |                                                       today
  |  /spawn-worker, merge, Trello, cleanup
  |
Workers (Claude Code in tmux, per-feature worktrees)
  |
  |  Phase 1-5, can split into child workers
  |  --dangerously-skip-permissions (zero friction)
  |
  (optional: session-bus events, phase signals)

--- future ---

Coordinator Daemon (Node.js, replaces Dispatcher)    <-- BUILT,
  |                                                       UNTESTED
  |  polls session-bus, surfaces approvals via coord CLI
  |  manages merges, cleanup, launchd auto-restart
```

---

## Developing This System (Self-Hosting)

This orchestration system was built using itself. To continue development:

```bash
# 1. Start Dispatcher in this repo
cd ~/.claude
claude

# 2. Check the backlog
> wip

# 3. Pick a card
> work on <card-name>       # spawns a worker in a worktree
```

### Curiosity Lab Board

The orchestration roadmap lives on the [Curiosity Lab](https://trello.com/b/vqVDt871/curiosity-lab) Trello board:

- **Inbox** — backlog (P1-P4 cards)
- **Researching** — actively being worked on
- **Findings** — completed and merged

### Next Steps for the System

1. **Deploy coordinator daemon** — `cd coordinator && npm install && npm run build && node build/index.js --main-worktree ~/.claude`
2. **Add tmux MCP to mcp.json** — enables MCP-based tmux operations
3. **Update worker prompt template** to publish session-bus events
4. **Integration test** — spawn a worker via coordinator, verify full lifecycle

---

## File Map

| Path | Purpose |
|------|---------|
| `CLAUDE.md` | Agent instructions (loaded into every session's system prompt) |
| `CHEATSHEET.md` | Human-readable workflow guide with examples |
| `settings.json` | Global Claude Code settings (permissions, hooks) |
| `mcp.json` | Active MCP server config (secrets — not committed) |
| `mcp.json.template` | MCP config template (committed, secrets redacted) |
| `coordinator/` | Coordinator daemon (Node.js) — autonomous L1 replacement |
| `mcp-servers/session-bus/` | Inter-session messaging MCP server |
| `skills/spawn-worker/` | `/spawn-worker` skill definition |
| `skills/adhoc/` | `/adhoc` skill definition |
| `hooks/` | Claude Code hooks (phase completion, pre-compact metrics) |
| `rules/` | Persistent rules that survive context compression |
| `plans/` | Implementation plans and research findings |

## New Machine Setup

```bash
# Clone into ~/.claude
git clone git@github.com:avovsya/claude_settings.git ~/.claude

# Set up MCP secrets
cp ~/.claude/mcp.json.template ~/.claude/mcp.json
# Edit mcp.json — add your Trello API key/token

# Build MCP servers
cd ~/.claude/mcp-servers/session-bus && npm install && npm run build

# (Optional) Build coordinator
cd ~/.claude/coordinator && npm install && npm run build

# Verify
claude --version
```

## Secrets

**Never commit `mcp.json`** — it contains API keys. Only `mcp.json.template` is tracked. The `.gitignore` uses a deny-by-default allowlist so new files are ignored automatically.
