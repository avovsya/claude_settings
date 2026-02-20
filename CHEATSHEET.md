# Multi-Agent Workflow Cheatsheet

Quick reference for operating the recursive worker orchestration system.

---

## Architecture Overview

```
You (L0: Human)
  |
  |  orchestrate, test output, approve plans
  |
  Dispatcher (L1: main repo Claude session)
  |
  |  manages Trello, git, tmux
  |  spawns workers, merges, cleans up
  |  NEVER writes code
  |
  Workers (recursive units, in feature worktrees)
  |
  |  Implementer mode: executes Feature Workflow (Phases 1-5)
  |  Coordinator mode: researches, plans, spawns child workers
  |     |
  |     Child Workers (same recursive unit, one level deeper)
  |        |
  |        (can recurse once more if needed)
```

### Worker Tree Example

```
Dispatcher (spawns with remaining_splits=2)
  |
  +-- Worker A [impl, rs=2] -- small task, fits in one context
  |
  +-- Worker B [coord, rs=2] -- large task, splits into phases
  |     +-- Worker B.1 [impl, rs=1] -- Phase 1
  |     +-- Worker B.2 [impl, rs=1] -- Phase 2
  |     +-- Worker B.3 [coord, rs=1] -- Phase 3 too large, splits again
  |           +-- Worker B.3a [impl, rs=0] -- LEAF (must complete)
  |           +-- Worker B.3b [impl, rs=0] -- LEAF (must complete)
  |
  +-- Worker C [impl, rs=2] -- another small task

rs = remaining_splits
impl = implementer mode (writes code)
coord = coordinator mode (spawns children)
LEAF = rs=0, cannot split further
```

### What remaining_splits Means

| Value | Meaning | If task is too large... |
|-------|---------|------------------------|
| 2 | Default from Dispatcher | Splits into children with rs=1 |
| 1 | Can split once more | Children are leaves (rs=0) |
| 0 | LEAF | Must complete or commit WIP and STOP |

Maximum tree depth: Dispatcher -> Worker -> Child -> Grandchild (4 levels).

---

## Your Role (L0: Human)

You are the orchestrator, tester, and quality gate. The system does NOT proceed without you at key transitions.

**What you do at each transition:**

| Transition | Your action |
|------------|-------------|
| Dispatcher -> Worker | "work on X" |
| Worker presents plan (Phase 3b) | Read plan, approve or request changes |
| Worker completes a phase | Attach to tmux, build, test, report back |
| Worker wants to split | Review decomposition plan, approve |
| Child worker finishes | Test output, tell parent "phase done" |
| All phases complete | Tell Dispatcher "finish task" |

---

## Session Management

### Starting a Dispatcher

The Dispatcher is just a Claude Code session running in your **main repo** (not a worktree). It reads the global `~/.claude/CLAUDE.md` which has all workflow definitions.

```bash
cd /path/to/your/main/repo
claude
```

That's it. Once running, give it commands like `"work on X"` or `"wip"`. Keep this session alive — it's long-lived and manages all your workers. If it crashes or runs out of context, resume with `claude --continue` in the same directory.

### Starting a Feature

Tell the Dispatcher:

```
"work on <card name>"          -- specific Trello card
"start working on <card>"      -- same thing
"work on next P1"              -- pick first P1-Critical from To Do
```

**What happens:**
1. Dispatcher finds the Trello card
2. Creates git worktree + branch
3. Copies submodules (if project has them)
4. Creates tmux session (2 panes: Claude top, shell bottom)
5. Writes prompt to /tmp/ and launches Claude in top pane
6. Opens iTerm tab attached to tmux
7. Moves Trello card to "Implementing"

### Monitoring Workers

```
"wip"                          -- dashboard of all active tasks
"task status"                  -- same thing
```

Shows enhanced dashboard:
```
| Task | Priority | tmux | Branch | Phase | Build | Last Activity | Health |
|------|----------|------|--------|-------|-------|---------------|--------|
| Feature X | P1 | active | feat/x | Phase 4 | PASS | 15m ago | 1 compaction |
| Bug Y | P2 | — | fix/y | Planning | — | 3h ago (STALE) | 0 compactions |
```

**Data sources:** Trello cards, tmux sessions, git worktrees + commit history, `Plans/PLAN_*.md`, build logs (per worktree), `/tmp/claude-phase-complete-*.json` (phase signals), `~/.claude/compaction-metrics.jsonl` (context health).

**Stale:** No commits in 2+ hours AND no active tmux → flagged for cleanup/resume.

### Testing Between Phases

**Your most important job.** After each phase:

1. Attach to the worker's tmux session: `tmux attach -t <name>`
2. Switch to bottom pane: `Ctrl-b Down`
3. Build and run the app
4. Test the output visually / aurally
5. Switch back to Claude pane: `Ctrl-b Up`
6. Tell the worker the result:
   - "looks good, proceed" -- next phase
   - "fix X" -- worker addresses feedback
   - "this approach isn't working" -- rethink

### Approving Plans

Workers stop at Phase 3b and present a plan. You must:
1. Read the plan (usually in Plans/PLAN_<NAME>.md)
2. Approve: "looks good" / "approved"
3. Or request changes: "change X to Y"

The worker will NOT write code until you approve.

### Finishing Tasks

Tell the Dispatcher:

```
"finish task <name>"           -- merge, Trello, cleanup
"complete task"                -- if context is clear
```

**What happens:**
1. Verifies build in worktree
2. Merges to main (with --no-ff)
3. Updates Trello card -> Done
4. Cleans up: tmux, worktree, branch

### Recovering Crashed Sessions

```
"recover task <name>"          -- find worktree, recreate tmux, resume
"resume task <name>"           -- same thing
```

The Dispatcher finds the worktree, recreates the tmux session if needed, and runs `claude --continue` to resume the most recent session.

---

## Coordinator Daemon (Alternative L1)

The `coordinator/` daemon is an autonomous alternative to the Claude Code Dispatcher session. It runs as a plain Node.js daemon (no LLM in the poll loop), monitors workers via session-bus, and surfaces approval gates via the `coord` CLI.

### Setup

```bash
cd coordinator && npm install && npm run build && npm link
```

### Start

```bash
node coordinator/build/index.js --main-worktree /path/to/main/repo
# Or via launchd (see coordinator/com.coordinator.agent.plist)
```

### Key CLI Commands

```
coord status                      # Dashboard: workers, approvals, merge queue
coord list                        # Pending approvals
coord approve [session-id]        # Approve plan or merge (--changes "feedback")
coord reject <session-id> "why"   # Reject with feedback
coord spawn <card-name>           # Request worker spawn
coord logs <session-id>           # Session-bus events for a worker
coord stop                        # Graceful shutdown
```

### How It Differs from the Dispatcher

| Aspect | Dispatcher | Coordinator Daemon |
|--------|------------|-------------------|
| Technology | Claude Code session (LLM) | Node.js daemon (no LLM) |
| Runs in | Terminal (foreground) | Background (launchd) |
| Approvals | "looks good" in chat | `coord approve` CLI |
| Monitoring | "wip" command | `coord status` CLI |
| Crash recovery | `claude --continue` | Auto-restart (launchd KeepAlive) |

See `coordinator/README.md` for full documentation.

---

## When a Worker Splits

**How you'll know:** The worker says something like:

> "This task is too large for one context. I've written N phase prompts.
> Ready to spawn child workers. Approve?"

**What to do:**

1. Review the plan (Plans/PLAN_<TASK>.md)
2. Approve: "yes, spawn them"
3. The worker creates tmux sessions for each phase
4. You test each child's output before the next one starts
5. When all children are done, tell the parent worker

**If a child is itself too large:** It can split again (if remaining_splits > 0). Same process -- you approve, it spawns grandchildren.

**If a leaf worker (rs=0) runs out of context:** It commits what it has and stops. The parent coordinator (or you) decides how to continue -- usually by spawning a fresh worker with `claude --continue` or a new prompt.

---

## Tmux Quick Reference

| Command | Action |
|---------|--------|
| `tmux ls` | List all sessions |
| `tmux attach -t <name>` | Attach to session |
| `Ctrl-b d` | Detach from session |
| `Ctrl-b Up` / `Ctrl-b Down` | Switch panes |
| `Ctrl-b z` | Zoom current pane (toggle) |
| `tmux kill-session -t <name>` | Kill session |

**Session layout:**
- Top pane (70%) = Claude Code
- Bottom pane (30%) = shell for building/testing

---

## Common Scenarios

### Start a new feature from a Trello card

1. In Dispatcher session: `"work on <card name>"`
2. Dispatcher sets everything up, opens iTerm tab
3. Attach to tmux, watch worker run Phase 1-2 (research)
4. Worker presents plan at Phase 3b -- review and approve
5. Worker implements (Phase 4) -- test between major parts
6. Worker finishes -- run final tests
7. In Dispatcher: `"finish task <name>"`

### Worker split into sub-phases

1. Worker presents phased plan -- review and approve
2. Worker spawns child sessions in tmux
3. For each child:
   a. Attach to child's tmux
   b. Watch it work / wait for completion
   c. Build and test output
   d. Tell parent worker "phase N done" (or "fix X")
4. When all phases done: tell parent "all phases complete"
5. In Dispatcher: `"finish task <name>"`

### Worker is stuck or context exhausted

| Situation | What happens | What to do |
|-----------|-------------|------------|
| Leaf worker (rs=0) | Commits WIP, stops | `"recover task <name>"` or spawn fresh worker |
| Worker with rs>0 | Should pivot to coordinator | Tell it: "consider splitting" |
| Coordinator exhausted | Uses `--continue` | Dispatcher can `"recover task <name>"` |

### All phases done, merge and clean up

1. In Dispatcher: `"finish task <name>"`
2. Dispatcher: verifies build, merges, updates Trello, cleans up
3. Or manually:
   ```
   cd <worktree> && <build command>
   cd <main-repo> && git merge <branch> --no-ff
   git worktree remove <worktree-path>
   tmux kill-session -t <name>
   ```

### Resume a crashed session

1. In Dispatcher: `"recover task <name>"`
2. Or manually: `cd <worktree> && claude --continue`

### Check status of all active workers

1. In Dispatcher: `"wip"`
2. Review: active tasks table (phase, build, last activity, health), stale tasks, backlog
3. Attach to any worker to check progress: `tmux attach -t <name>`

---

## The Feature Implementation Workflow (What Workers Do)

```
Phase 1: Deep Research          -- parallel Explore sub-agents
Phase 2: Cross-Cutting Analysis -- thread safety, state flow, dependencies
  |
  +-- Context Capacity Check    -- can this fit in one context?
  |     YES -> continue         -- Implementer mode
  |     NO  -> split            -- Self-Replication Protocol
  |
Phase 3a: Draft Plan            -- PLAN_<NAME>.md
Phase 3b: Expert Review Panel   -- critic agents review plan
  |
  STOP -- wait for your approval
  |
Phase 4: Implementation         -- sequential, build after each part
Phase 5: Verification           -- review agents check everything
  |
Completion -> Finish Task       -- build, docs, commit, Trello
```

Workers can start at any phase (not just Phase 1):
- Phase 1: Full research needed (new territory)
- Phase 4: Plan already approved, design doc provided (most common for child workers)
- Phase 5: Code done, just needs review
