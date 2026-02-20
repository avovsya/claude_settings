# Coordinator Agent

Persistent Node.js daemon that manages Claude Code worker sessions. Replaces the long-running Claude Code L1 Dispatcher session with an autonomous coordinator that polls session-bus for events, manages tmux sessions, and surfaces human approval gates.

## Architecture

```
L0: Human (coord CLI)
    |
L1: Coordinator Daemon (this)
    |-- Reads session-bus events
    |-- Controls tmux sessions
    |-- Manages git worktrees/merges
    |-- Updates Trello cards
    |
    +-- Worker A (tmux, claude --dangerously-skip-permissions)
    +-- Worker B (tmux, claude --dangerously-skip-permissions)
```

Workers remain tmux CLI processes (not SDK sessions) to preserve:
- Human debuggability via `tmux attach`
- Recursive Worker Model (workers can self-replicate)
- CLAUDE.md auto-loading

## Setup

```bash
cd coordinator
npm install
npm run build
npm link          # makes `coord` available on PATH
```

## Usage

### Start the coordinator daemon

```bash
node build/index.js --main-worktree /path/to/main/worktree
```

### CLI tool

```bash
coord status                          # Show coordinator and worker status
coord list                            # Show pending approvals
coord approve [session-id] [--changes "text"]  # Approve with optional feedback
coord reject <session-id> "reason"    # Reject with feedback
coord spawn <card-name>               # Request worker spawn (Trello integration pending)
coord logs <session-id>               # Show session-bus events
coord stop                            # Stop the coordinator daemon
```

### launchd (auto-start on login)

Edit `com.coordinator.agent.plist` to fill in your paths, then:

```bash
cp com.coordinator.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.coordinator.agent.plist
```

## State

| Store | Location | Purpose |
|-------|----------|---------|
| `coordinator.db` | `~/.claude/coordinator/coordinator.db` | Worker registry, dependencies, approvals, merge queue |
| Session-bus | `~/.claude/session-bus/` | Worker events and session metadata |
| Decisions | `~/.claude/coordinator/decisions/` | Human approval responses |
| Logs | `~/.claude/coordinator/logs/` | Structured JSON logs |

## Approval Flow

1. Worker publishes `plan_ready` event on session-bus
2. Coordinator creates approval record, notifies human (bell + macOS notification)
3. Human reviews plan, runs `coord approve` or `coord reject`
4. Coordinator delivers decision to worker via tmux
5. Worker continues or revises

The coordinator never auto-approves plans or merges.

## Merge Flow

1. Worker completes (session-bus status: `completed`)
2. Coordinator creates merge approval request
3. Human approves via `coord approve`
4. Coordinator executes `git merge --no-ff` from main worktree
5. Cleanup: worktree remove, branch delete, tmux kill

Safety: never uses `--force` on worktree remove, never uses `-D` on branch delete.
