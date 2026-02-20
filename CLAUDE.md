# Global Claude Code Recipes

Human-readable reference for the human operator: `CHEATSHEET.md`

---

## Dispatcher: Working on Trello Cards

**Triggers:** "start working on card/task X", "work on X", "work on next P1"

The Dispatcher is **L1** — it manages Trello, git, tmux, and spawns workers. It **never writes implementation code**.

Use `/spawn-worker` — it handles the full spawn cycle. See `skills/spawn-worker/SKILL.md` for complete instructions.

```
/spawn-worker <card-name-or-url> [--splits N] [--phase N]
/spawn-worker next                # next P1-Critical from To Do
```

### Quick Reference (what /spawn-worker does)

1. **Find card** — Trello MCP search (handles 0/multiple matches, "next" for P1)
2. **Verify state** — Card state (implementing/done?) + git clean check
3. **Branch + worktree** — `<type>/<kebab-title>`, `git worktree add`
4. **Submodules** — Auto-detect from `.gitmodules`, copy from main worktree
5. **Trello** — Move to "Implementing" (or "Researching" for Curiosity Lab), append metadata
6. **tmux** — 2-pane (70% Claude / 30% shell)
7. **Worker prompt** — Write to `/tmp/<session>-prompt.md`, launch with `unset CLAUDECODE && cat | claude`
8. **iTerm2 tab** — Auto-attach (graceful fallback)
9. **Report** — Worktree path, branch, attach command

---

## Recursive Worker Model

Every worker session is the same recursive unit. It receives a task and self-evaluates scope:

```
Worker(task, start_phase, remaining_splits):
  if remaining_splits == 0:
    execute_feature_workflow(task, start_phase)     # LEAF -- must complete
    if context_exhausted: commit_wip(); STOP

  elif fits_in_one_context(research):
    execute_feature_workflow(task, start_phase)      # Implementer

  else:
    plan = decompose_into_phases(task)               # Coordinator
    for phase in plan:
      spawn Worker(phase, determine_start_phase(phase), remaining_splits - 1)
      wait_for_human_test()
```

### Two Modes

| Mode | When | Behavior |
|------|------|----------|
| **Implementer** | Task fits in one context, OR `remaining_splits == 0` | Executes Feature Implementation Workflow from `start_phase` |
| **Coordinator** | Task too large AND `remaining_splits > 0` | Researches, plans, decomposes into sub-phases, spawns child workers |

### Parameters

**`start_phase`** (1-5): Which phase to begin at.
- **1 (Research):** New feature, unknown territory
- **2 (Cross-cutting):** Research provided by parent
- **3 (Planning):** Analysis done, need plan
- **4 (Implementation):** Plan approved, design doc provided
- **5 (Verification):** Code done, review pass

**`remaining_splits`** (0-2): How many more times this worker can auto-split.
- **2** (default from Dispatcher): can split twice
- **1**: can split once more
- **0**: LEAF -- must complete or commit WIP and STOP

### Pivot

A worker may start as Implementer, begin Phase 1 research, and realize the task won't fit. If `remaining_splits > 0`, it pivots to Coordinator mode: writes a multi-phase plan, gets human approval, spawns children with `remaining_splits - 1`.

### Parallel Worker Groups

Coordinators may spawn parallel groups with **file ownership boundaries** to prevent conflicts:
- By device/module category (3 workers for independent subsystems)
- By concern (design worker + implementation worker)
- By UI area (board layout + detail sheet)

Specify in each child's prompt: "Do NOT modify <files> (another worker owns these)"

### Context Capacity Check (mandatory at Phase 2 completion)

After completing Phase 2 cross-cutting analysis, STOP and evaluate:

1. **Hard stops** (any one triggers SPLIT):
   - Context compacted 2+ times already
   - Plan needs >= 5 implementation phases
   - Research synthesis > 500 lines (~80K tokens)

2. **Weighted score** (> 0.6 triggers SPLIT):
   - `0.3 * min(1.0, files_to_modify / 15) + 0.7 * cross_cutting_complexity`
   - Cross-cutting: count high-complexity concerns (thread safety, state mgmt, UI, etc.)

3. **Tiebreaker:** Self-judgment -- "Can I complete Phases 3-5 in ~120K remaining tokens?"

If `remaining_splits == 0`: skip this check, implement regardless (you are a leaf).

### Self-Replication Protocol (when SPLIT)

When a worker decides to split:

1. **COMMIT** Phase 1-2 checkpoint (`WIP: Phase 2 complete -- splitting to coordinator mode`)
2. **WRITE** `Plans/FINDINGS_<TASK>.md` -- consolidated research (becomes child context)
3. **WRITE** `Plans/PLAN_<TASK>.md` -- phased breakdown with file ownership, start_phase per child, dependencies
4. **WRITE** `/tmp/phase-{N}-prompt.md` for each phase, including:
   - Task scope and file boundaries
   - Key findings excerpt
   - `start_phase: {N}` and `remaining_splits: {current - 1}`
5. **SIGNAL** human: "Task too large for one context. N phase prompts ready. Approve?"
6. **WAIT** for human approval
7. **SPAWN** children via tmux: `unset CLAUDECODE && cat /tmp/phase-N-prompt.md | claude`
8. **BECOME** Coordinator -- no more implementation code, just reads children's output, writes next prompts

### Agent Roles (within any worker)

| Role | Tool | Purpose |
|------|------|---------|
| Coordinator | Main session | Plan, delegate, synthesize, integrate |
| Analysis Agent | Task (Explore) | Deep-read scoped area, report findings |
| Domain Expert | Task (Explore) | Critique plan as specialist |
| Implementation Agent | Task (general-purpose) | Write code in focused module |
| Review Agent | Task (Explore) | Verify correctness, consistency |

### Sub-Agent Discipline

- One module, one concern per agent
- Read deeply (every file in scope), not skim
- Report: (1) findings, (2) changes made, (3) cross-module impacts
- Coordinator reviews all output before proceeding
- Parallel for independent areas; sequential when dependent
- **Cost efficiency:** Sub-agents don't inherit parent context or share caches — each is an isolated conversation. To reduce redundant token usage:
  - Give each agent a focused, non-overlapping file scope (avoid 5 agents all reading the same files)
  - Include shared context excerpts in the Task prompt rather than having each agent independently read the same docs
  - Use `model: "haiku"` for Explore/review agents (default); reserve Opus for coordinator reasoning

### Background Agent Usage

During Phase 4, proactively parallelize:
- Pre-research next module (Explore, background) while implementing current one
- Build verification (background) after each major change
- Architecture review of cross-module impacts while implementation continues

Rules:
- Analysis/review agents -> always background
- Implementation agents -> always foreground and sequential
- Two implementation agents CAN run in parallel if they touch different files with no overlap
- Coordinator reviews each background agent's output before acting on it

### Feature Implementation Workflow (Phases 1-5)

> Discovery agents should read relevant docs/READMEs first and flag inaccuracies.

**Phase 1 -- Deep Research** (MANDATORY before code)
Spawn parallel Explore agents for: module internals, similar patterns, data flow, domain expertise. Synthesize into unified understanding.

**Phase 2 -- Cross-Cutting Analysis**
Spawn agents for: thread safety, state flow / UI bindings, implicit dependencies. Synthesize into risk assessment.
**-> Run Context Capacity Check here. If SPLIT, follow Self-Replication Protocol.**

**Phase 3a -- Draft Implementation Plan**
Write `PLAN_<NAME>.md` in `Plans/`. Must include: architecture + rationale, files/classes to change, dependency order, cross-cutting mitigations, edge cases, testing.

**Phase 3b -- Expert Review Panel** (MANDATORY before presenting to user)
Spawn parallel Review Agents to critique the draft plan. Select reviewers based on domain:
- Software Architect (ALWAYS)
- Thread Safety Reviewer (if concurrency)
- UX/UI Expert (if UI changes)
- Domain Expert (if specialized -- audio, security, performance, etc.)
Incorporate feedback, then present final plan. **Stop and wait for user approval.**

**Phase 4 -- Implementation**
Follow plan with todo tracking. Spawn Implementation Agents per area. Coordinator reviews each before proceeding. Build after each major part. User approval between phases.

**Phase 5 -- Verification**
Spawn parallel Review Agents per module + cross-module agent. Fix issues before proceeding.

**Completion** -> Run Finish Task workflow.

### Key Principles

- Analyze deeply before writing code
- Explore parallel, implement sequential
- Plan first, approve, then code
- Coordinator never blindly merges sub-agent output
- Cross-cutting analysis is mandatory
- Match existing codebase patterns
- Verify with independent review agents
- Build frequently

---

## Context Management

**Within a session:**
- `/compact` when context is long but task is mid-phase
- NEVER `/compact` during Phase 1-2 synthesis -- sub-agent findings may be lost
- Plan compaction points between phases, not during them

**Context exhaustion:**
- **Implementer (remaining_splits > 0):** If context fills during research/planning, consider pivoting to Coordinator
- **Implementer (remaining_splits == 0, LEAF):** Finish current unit, commit WIP, write `COMPLETION_REPORT.md` ("Partial -- needs continuation"), STOP
- **Any worker during Phase 4:** Finish current implementation unit, commit, then `claude --continue`
- **Coordinator:** Use `--continue` to resume; plan docs + Trello serve as external memory

**2 compaction rule:** Any worker compacted 2+ times before reaching Phase 4 should evaluate splitting (if `remaining_splits > 0`) or commit WIP and stop (if leaf).

**Fresh sessions:**
- `claude --continue` when starting a new phase or after a major milestone
- Never `/compact` when synthesizing sub-agent findings

---

## Finish Task

**Triggers:** "finish task", "complete task", "done with this task"

**Step 1:** Verify build passes -- if fails, fix first

**Step 2:** Update plan: mark PLAN_<NAME>.md complete, add status + date, document deviations

### Documentation Maintenance (mandatory on every feature completion)

Before committing, spawn a Review Agent (Explore) to check if project docs need updating:
- Architecture docs -- new classes, changed module boundaries, dependencies, data flow
- Developer guide -- new patterns, anti-patterns, lessons learned, gotchas
- Per-directory READMEs -- new files, changed APIs, integration points
- Rules files -- new constraints discovered (thread safety, conventions)
- Skills -- common manual tasks that should be automated, or stale skill steps
- Project CLAUDE.md -- if imports or references need updating

The Review Agent should:
1. Read the git diff of all changes in this feature
2. Compare against existing docs
3. Report what's stale or missing
4. Coordinator updates docs before final commit

Documentation changes are committed alongside feature code, not as separate commits.

**Step 3:** Commit:
```bash
git add -A
git commit -m "<type>: <description>

<detailed summary>

Plan: Plans/PLAN_<NAME>.md
Trello: <card-url>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

**Step 4:** Update Trello: move to "Testing" or "Done" (ask user), update description with date/plan/commits/status

**Step 5:** Merge (if requested):
```bash
cd /path/to/main/worktree
git checkout main
git merge <feature-branch> --no-ff -m "Merge <branch-name>: <description>"
```

**Step 6:** Cleanup (ask user):
```bash
git worktree remove /path/to/feature/worktree
git branch -d <branch-name>
tmux kill-session -t <session-name>
```

**Step 7:** Report: build status, plan doc, commit hash, Trello list, merge status, cleanup status, files/lines changed

---

## Task Status

**Triggers:** "wip", "task status", "what am I working on"

1. Gather: Trello "Implementing" cards, active tmux sessions, PLAN_*.md files, P1/P2 from "To Do"
2. Show active tasks table: Task | Priority | tmux | Branch | Worktree | Plan | Phase
   - Phase: "Discovery" (no PLAN) -> "Planning" (PLAN exists) -> "Implementation" (commits after plan) -> "Completed" (merged)
3. Show stale tasks: "Implementing" cards without active tmux/recent activity -> suggest cleanup or resume
4. Show high priority backlog: P1-Critical + P2-High from To Do
5. Suggest actions: attach, start working, finish task, recover task

---

## Recover Task

**Triggers:** "recover task X", "resume task X", "restore session X"

Sessions at: `~/.claude/projects/-<path-with-dashes>/<session-id>.jsonl`
Each worktree = effectively named by task.

**Step 1:** Find worktree:
```bash
MAIN_WORKTREE=$(git worktree list | head -1 | awk '{print $1}')
PARENT_DIR=$(dirname "$MAIN_WORKTREE")
PROJECT=$(basename "$MAIN_WORKTREE")

git worktree list | grep -i "<task-name>"
ls -d ${PARENT_DIR}/${PROJECT}-*/ | grep -i "<task-name>"
```

**Step 2:** Check session files:
```bash
WORKTREE_PATH="${PARENT_DIR}/${PROJECT}-<task-name>"
PROJECT_DIR=$(echo "$WORKTREE_PATH" | sed 's|/|-|g' | sed 's|^-||')
ls ~/.claude/projects/${PROJECT_DIR}/*.jsonl 2>/dev/null
```

**Step 3:** Check tmux: `tmux list-sessions | grep -i "<task-name>"`

**Step 4a:** tmux exists, Claude not running -> attach + `claude --continue`

**Step 4b:** No tmux session:
```bash
tmux new-session -d -s <session-name> -c "$WORKTREE_PATH"
tmux split-window -t <session-name> -v -p 30 -c "$WORKTREE_PATH"
tmux send-keys -t <session-name>:.1 "unset CLAUDECODE && claude --continue" Enter
osascript <<EOF
tell application "iTerm2"
    tell current window
        create tab with default profile
        tell current session
            write text "tmux attach -t <session-name>"
        end tell
    end tell
end tell
EOF
```

**Step 5:** Report: worktree found, session found, tmux recreated, Claude resumed

**Notes:** `claude --continue` = most recent session in cwd. `claude --resume <id>` = specific session. Multiple sessions -> use `claude --resume` with picker.

---

## "I'm Bored"

**Triggers:** "i'm bored", "what should I work on", "pick something fun", "surprise me"

1. Gather: P1-Critical from To Do, recent cards (7 days), "Freezebox and Ideas" list, experimental cards
2. Categorize: HOT (P1, recent) | BUGS (quick wins) | FUN FEATURES (creative) | COOL IDEAS (freezebox) | RANDOM PICK
3. Per suggestion: card name + link, one-line hook, complexity hint (quick/medium/deep)
4. Offer: "start working on X", "tell me more about X", "shuffle"

**Selection criteria:** interesting technical challenge, visible result, experimental/creative, performance/music-focused, recently brainstormed

---

## Curiosity Lab

**Triggers:** "curio", "curiosity", "I wonder", "research idea"

**Board:** [Curiosity Lab](https://trello.com/b/vqVDt871/curiosity-lab) (ID: `68e392ae2b71aa7ba30e8c92`)

**Lists:**
- Inbox (`698b63e8e2b5cfadb042f7fc`) -- raw ideas
- Researching (`698b63e9123e9eb3c5eeb7a3`) -- actively investigating
- Findings (`698b63ea963859732572676e`) -- results and conclusions
- Parked (`698b63ead80c1ef2f75ac44d`) -- interesting but not now

**What to do:**
1. Create card in Inbox list with:
   - Clear title: "Research: <topic summary>"
   - Description with: core question, specific sub-questions to explore, related concepts, what a good answer looks like
2. Append user's exact prompt(s) at the bottom under "## Raw Prompts (Original Thinking)" as blockquotes
3. Report: card link + brief summary of what was captured

**Card description structure:**
```
## Core Question
<distilled version of what user wants to explore>

## Specific Areas to Explore
<break down into numbered sub-topics with bullet points>

## Related Concepts
<adjacent fields, frameworks, analogies>

## What Would a Good Answer Look Like?
<deliverables, format, depth>

## Raw Prompts (Original Thinking)
> <user's exact words, preserved verbatim>
```

**If user says "research this curio" or "dig into curio X":** move card to Researching, then do actual research (web search, papers, synthesis) and update the card with findings.
