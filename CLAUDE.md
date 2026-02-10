# Global Claude Code Recipes

Human-readable reference with diagrams and examples: `CLAUDE_REFERENCE.md`

---

## Working on Trello Cards

**Triggers:** "start working on card/task X", "work on X", "work on next P1"

For "next high priority": fetch P1-Critical cards from To Do list, pick first.

### Setup (Current Session)

**Step 1: Find card**
- Trello MCP search by name
- 0 matches → fuzzy search or ask user
- Multiple matches → list and ask user
- "next high priority" → P1-Critical from To Do list

**Step 2: Verify card state**
- Already in "Implementing" with branch → ask: resume or start fresh?
- In "Done"/"Archived" → warn and confirm

**Step 3: Verify git state**
```bash
git status --porcelain
# Uncommitted changes → warn and stop
```

**Step 4: Create branch name**
- Kebab-case from card title: `<type>/<short-description>` (max 50 chars)
- Types: `feature/`, `fix/`, `refactor/`, `docs/`
- Too long → suggest shorter, confirm with user

**Step 5: Create worktree**
```bash
git worktree list | grep <branch-name>
git branch --list <branch-name>
git worktree add -b <branch-name> /absolute/path/to/parent/<project>-<branch-name> main
```

**Step 6: Update Trello**
- Move card to "Implementing"
- Append to description: Branch, Worktree path, Started date

**Step 7: Start tmux**

Sessions stored per-directory at `~/.claude/projects/`. Each worktree = named session. Resume with `claude --continue` or `recover task <name>`.

```bash
tmux new-session -d -s <session-name> -c /absolute/path/to/worktree
tmux split-window -t <session-name> -v -p 30 -c /absolute/path/to/worktree
# Pane 1 (top 70%): Claude Code | Pane 2 (bottom 30%): shell
```

**Step 8: Start Claude with initial prompt**

The prompt MUST include the FULL workflow instructions. Build as follows:

```bash
PROMPT='## Task: <card-name>

**Branch:** <branch-name>
**Card Description:** <card-description-summary>

---

## MANDATORY Feature Implementation Workflow (Hierarchical Agent Architecture)

You are the COORDINATOR. Delegate to sub-agents (Task tool), synthesize, integrate.
NEVER write code without completing Phases 1-3.

**Phase 1: Deep Research (MANDATORY — no code before this completes)**
Spawn PARALLEL Analysis Agents (Task tool, subagent_type=Explore):
- Agent A: Read every file in relevant module. Report: public API, state, threading, connections.
- Agent B: Find all existing similar patterns. Report: conventions, file structure, naming.
- Agent C: Trace data flow for relevant feature. Report: entry points, transformations, UI bindings.
- Agent D (if needed): Domain expert review (UX/UI, DSP, architecture, music).
Synthesize all findings. Answer: "What exists and how does it work?"

**Phase 2: Cross-Cutting Analysis**
Spawn targeted Analysis Agents:
- Thread safety implications
- State flow and UI binding impacts
- Implicit dependencies (notifications, KVO, delegates, globals)
Synthesize into risk assessment.

**Phase 3a: Draft Implementation Plan**
Create PLAN_<FEATURE_NAME>.md in Plans/:
- Architecture overview with rationale from research
- Specific files/classes to modify with what and why
- Implementation order (dependencies first)
- Cross-cutting concerns and mitigations
- Edge cases, error handling, thread safety

**Phase 3b: Expert Review Panel (MANDATORY before presenting to user)**
Spawn PARALLEL Review Agents to critique the draft plan. Select based on what the task touches:
- Software Architect (ALWAYS): structural soundness, coupling, patterns, API design
- Thread Safety Reviewer (if concurrency involved): races, deadlocks, synchronization strategy
- UX/UI Expert (if UI changes): layout, interaction, accessibility, consistency
- DSP Engineer (if audio/signal processing): latency, buffer handling, real-time safety
- Musician (if musical features): workflow feel, musical correctness, creative utility
Incorporate feedback into plan. Then present final plan to user.
STOP. Do NOT write code until user approves.

**Phase 4: Implementation**
- Follow plan with todo tracking, dependency order
- Spawn focused Implementation Agents per major area
- Coordinator reviews each output before proceeding
- Build/test after each major part: ./Scripts/build.sh
- Wait for user approval between major phases

**Phase 5: Verification**
- Spawn parallel Review Agents per module (correctness, consistency, regressions)
- Spawn cross-module Review Agent (integration integrity)
- Fix issues before proceeding

**Completion**
- On "finish task": verify build, update plan doc, commit, report summary

---

**START NOW: Phase 1 (Deep Research). Spawn parallel Analysis Agents.**'

tmux send-keys -t <session-name>:.1 "claude \"$PROMPT\"" Enter
```

**Step 9: Open iTerm2 tab**
```bash
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

**Step 10: Report**
```
Output:
  ✓ Worktree: ../<project>-<branch-name>
  ✓ Trello card → Implementing
  ✓ Claude Code running in tmux

  Attach: tmux attach -t <session-name>
  Panes: Top = Claude Code, Bottom = shell
  Ctrl-b ↑/↓ switch | Ctrl-b d detach | tmux ls list
```

---

## Feature Workflow Reference (for Coordinator)

The Coordinator (main Claude session) delegates to sub-agents, synthesizes, integrates. Never writes code without understanding the full picture first.

> **Note:** Discovery agents (Phase 1) should always read relevant docs/READMEs first and flag any inaccuracies they find during research. Doc fixes found during research are tracked and applied at Completion.

### Agent Roles

| Role | Tool | Purpose |
|------|------|---------|
| Coordinator | Main session | Plan, delegate, synthesize, integrate |
| Analysis Agent | Task (Explore) | Deep-read scoped area, report findings |
| Domain Expert | Task (Explore) | Critique plan as specialist (architect, DSP, UX, musician) |
| Implementation Agent | Task (general-purpose) | Write code in focused module, report changes |
| Review Agent | Task (Explore) | Verify correctness, consistency, side effects |

### Sub-Agent Discipline

- One module, one concern per agent
- Read deeply (every file in scope), not skim
- Report: (1) findings, (2) changes made, (3) potential cross-module impacts
- Coordinator reviews all output for coherence before proceeding
- Parallel for independent areas; sequential when dependent

### Background Agent Usage

During Phase 4 (Implementation), proactively use background agents to parallelize work:
- Pre-research the next module (Explore, background) while implementing the current one
- Run build verification (build-checker agent, background) after each major change
- Have architecture-reviewer check cross-module impacts while implementation continues
- Pre-analyze related systems while current module implementation is in progress

Rules:
- Analysis/review agents → always background (no write conflicts)
- Implementation agents → always foreground and sequential (avoid write conflicts on same files)
- If two implementation agents touch different modules with no shared files, they CAN run in parallel
- Coordinator must review each background agent's output before acting on it

### Phase Summary

**Phase 1 — Deep Research** (MANDATORY before code)
Spawn parallel Explore agents for: module internals, similar patterns, data flow, domain expertise. Synthesize into unified understanding.

**Phase 2 — Cross-Cutting Analysis**
Spawn agents for: thread safety, state flow / UI bindings, implicit dependencies. Synthesize into risk assessment.

**Phase 3a — Draft Implementation Plan**
Write `PLAN_<FEATURE_NAME>.md` in `Plans/`. Must include: architecture + rationale, files/classes to change, dependency order, cross-cutting mitigations, edge cases, testing.

**Phase 3b — Expert Review Panel** (MANDATORY before presenting to user)
Spawn parallel Review Agents to critique the draft plan. Select reviewers based on task scope:
- Software Architect (ALWAYS): structural soundness, coupling, patterns, API design
- Thread Safety Reviewer (if concurrency): races, deadlocks, synchronization
- UX/UI Expert (if UI): layout, interaction, accessibility, consistency
- DSP Engineer (if audio/signal): latency, buffers, real-time safety
- Musician (if musical features): workflow feel, musical correctness, creative utility
Incorporate feedback, then present final plan. **Stop and wait for user approval.**

**Phase 4 — Implementation**
Follow plan with todo tracking. Spawn Implementation Agents per area. Coordinator reviews each before proceeding. Build after each major part. User approval between phases.

**Phase 5 — Verification**
Spawn parallel Review Agents per module + cross-module agent. Fix issues before proceeding.

**Completion** → Run Finish Task workflow.

### Key Principles

- Analyze deeply before writing code
- Explore parallel, implement sequential
- Plan first, approve, then code
- Coordinator never blindly merges
- Cross-cutting analysis is mandatory
- Match existing codebase patterns
- Verify with independent review agents
- Build frequently

---

## Context Management

- `/compact` when context is getting long but task is mid-phase and you need to continue
- Fresh session (`claude --continue`) when starting a new phase or after completing a major milestone
- NEVER `/compact` during Phase 1-2 synthesis — sub-agent findings in coordinator context may be lost
- If context is full during Phase 4: finish current implementation unit, commit, then fresh session with `claude --continue`
- Sub-agent heavy workflows fill context fast — monitor and plan compaction points between phases, not during them

---

## Finish Task

**Triggers:** "finish task", "complete task", "done with this task"

**Step 1:** Verify build: `./Scripts/build.sh` — if fails, fix first

**Step 2:** Update plan: mark PLAN_<FEATURE_NAME>.md complete, add status + date, document deviations

### Documentation Maintenance (mandatory on every feature completion)

Before committing, spawn a Review Agent (Explore) to check if any of these need updating:
- docs/ARCHITECTURE.md — new classes, changed module boundaries, new dependencies, signal flow changes
- docs/DEVELOPER_GUIDE.md — new patterns, anti-patterns discovered, lessons learned, new gotchas
- Per-directory READMEs — new files, changed APIs, new integration points
- .claude/rules/ — new constraints discovered (e.g. thread safety issue found, new convention established)
- .claude/skills/ — if a common task was done manually that should be a skill, or existing skill steps are now wrong
- Project CLAUDE.md — if @ imports need updating

The Review Agent should:
1. Read the git diff of all changes in this feature
2. Compare against existing docs
3. Report what's stale or missing
4. Coordinator updates docs before final commit

If new patterns or anti-patterns were discovered during implementation:
- Add patterns to DEVELOPER_GUIDE.md with rationale
- Add anti-patterns with "why this breaks" explanation
- If it's a hard constraint, add a .claude/rules/ entry scoped to the relevant paths

Documentation changes are committed alongside feature code, not as separate commits.

**Step 3:** Commit:
```bash
git add -A
git commit -m "<type>: <description>

<detailed summary>

Plan: Plans/PLAN_<FEATURE_NAME>.md
Trello: <card-url>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
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
   - Phase: "Discovery" (no PLAN) → "Planning" (PLAN exists) → "Implementation" (commits after plan) → "Completed" (merged)
3. Show stale tasks: "Implementing" cards without active tmux/recent activity → suggest cleanup or resume
4. Show high priority backlog: P1-Critical + P2-High from To Do
5. Suggest actions: attach, start working, finish task, recover task

---

## Recover Task

**Triggers:** "recover task X", "resume task X", "restore session X"

Sessions at: `~/.claude/projects/-<path-with-dashes>/<session-id>.jsonl`
Each worktree = effectively named by task.

**Step 1:** Find worktree:
```bash
# Derive project paths from main worktree
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

**Step 4a:** tmux exists, Claude not running → attach + `claude --continue`

**Step 4b:** No tmux session:
```bash
tmux new-session -d -s <session-name> -c "$WORKTREE_PATH"
tmux split-window -t <session-name> -v -p 30 -c "$WORKTREE_PATH"
tmux send-keys -t <session-name>:.1 "claude --continue" Enter
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

**Notes:** `claude --continue` = most recent session in cwd. `claude --resume <id>` = specific session. Multiple sessions → use `claude --resume` with picker.

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
- Inbox (`698b63e8e2b5cfadb042f7fc`) — raw ideas
- Researching (`698b63e9123e9eb3c5eeb7a3`) — actively investigating
- Findings (`698b63ea963859732572676e`) — results and conclusions
- Parked (`698b63ead80c1ef2f75ac44d`) — interesting but not now

**What to do:**
1. Create card in Inbox list with:
   - Clear title: "Research: <topic summary>"
   - Description with: core question, specific sub-questions to explore, related concepts, what a good answer looks like
2. Append user's exact prompt(s) at the bottom of the description under "## Raw Prompts (Original Thinking)" as blockquotes
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
