# Multi-Agent Orchestration Analysis

> Analysis of the actual multi-agent workflow patterns used in the Morph project,
> derived from mining 103 Claude Code session transcripts across 28 worktrees
> (Feb 1-19, 2026). Total data: ~400MB of JSONL session logs.

---

## 1. Executive Summary

The Morph project uses a **recursive agent tree** for complex feature development. There are only two fixed roles and one recursive unit type:

| Role | Actor | Description |
|------|-------|-------------|
| **L0: Human** | The user | Orchestrator, tester, quality gate. Tests output between every phase. Routes status between sessions. |
| **L1: Dispatcher** | Coordinator Claude session (main worktree) | Task management, Trello, spawns root workers, merges completed work. Never writes code. |
| **Worker** | Claude session (feature worktree, any depth) | The recursive unit. Self-evaluates task scope and operates in one of two modes. |

### The Recursive Worker (the core abstraction)

Every worker in the tree is the same type. It receives a task and decides:

```
Worker(task, context, start_phase):
  research = evaluate_scope(task)            # Always starts with research

  if fits_in_one_context(research):
    execute_feature_workflow(task, start_phase)  # IMPLEMENTER mode
  else:
    plan = decompose_into_phases(research)
    for each phase in plan:
      spawn Worker(phase, sub_context, appropriate_start_phase)  # COORDINATOR mode
      wait_for_human_test_and_approval()
```

**Two modes, one definition:**

| Mode | When | What it does |
|------|------|-------------|
| **Implementer** | Task fits in one context window, OR `remaining_splits == 0` | Executes Feature Implementation Workflow from the appropriate starting phase |
| **Coordinator** | Task is too large AND `remaining_splits > 0` | Researches, plans, decomposes into sub-phases, spawns child workers in tmux/iTerm |

**Two key parameters:**

`start_phase` — not every worker starts from scratch:
- **Phase 1 (Research):** New feature, unknown territory
- **Phase 2 (Cross-cutting analysis):** Research provided by parent coordinator
- **Phase 3 (Planning):** Analysis done, need architecture plan
- **Phase 4 (Implementation):** Plan approved, design doc provided, jump to coding
- **Phase 5 (Verification):** Code done, need review pass

`remaining_splits` — controls recursion depth:
- **2** (default from Dispatcher): can split twice (max tree depth = 4 including L1)
- **1**: can split once more
- **0**: leaf worker — must complete in one context or stop and report

```
Worker(task, context, start_phase, remaining_splits):
  research = evaluate_scope(task)

  if remaining_splits == 0:
    # LEAF: must implement, no splitting allowed
    execute_feature_workflow(task, start_phase)
    if context_exhausted_before_done:
      commit_progress()
      write_completion_report("Partial — needs continuation")
      STOP

  elif fits_in_one_context(research):
    execute_feature_workflow(task, start_phase)     # Implementer

  else:
    plan = decompose_into_phases(research)          # Coordinator
    for phase in plan.phases:
      spawn Worker(phase, sub_context,
                   determine_start_phase(phase),
                   remaining_splits - 1)            # Decrement!
      wait_for_human_test_and_approval()
```

**Pivot scenario:** A worker may start in implementer mode, begin Phase 1 research, and realize the task won't fit. If `remaining_splits > 0`, it pivots: writes a multi-phase plan and switches to coordinator mode, spawning child workers with `remaining_splits - 1`.

**Paired sessions:** Coordinators often spawn two workers per phase — a **design/creative session** (UX, mockups, interaction) and an **implementation session** (code). These are both just workers; the design worker starts at Phase 1, the implementation worker starts at Phase 3 or 4 with the design output as context.

### The Tree

```
L1: Dispatcher (spawns with remaining_splits=2)
  │
  ├── Worker[impl, rs=2] — small task, fits in one context
  │
  ├── Worker[coord, rs=2] — large task, splits
  │     │
  │     ├── Worker[impl, rs=1] — Phase A design
  │     ├── Worker[impl, rs=1] — Phase A code
  │     ├── Worker[impl, rs=1] — Phase B design
  │     ├── Worker[coord, rs=1] — Phase B code too large, splits again
  │     │     │
  │     │     ├── Worker[impl, rs=0] — sub-phase B.1 (LEAF)
  │     │     └── Worker[impl, rs=0] — sub-phase B.2 (LEAF)
  │     │
  │     └── Worker[impl, rs=1] — Phase C
  │
  └── Worker[impl, rs=2] — another small task

Legend: rs = remaining_splits
        impl = implementer mode
        coord = coordinator mode (spawns children)
        LEAF = remaining_splits=0, cannot split further
```

The tree grows organically up to **max depth 4** (L1 + 2 splits + leaf). Human tests output at every node transition.

**Observed depths (historical):**
- **Depth 1 (no splits):** Most single-feature tasks (bipolar faders, range faders, sidechain pump)
- **Depth 2 (1 split):** Multi-phase features (board-fader-columns: 14 child workers)
- **Depth 3 (2 splits):** One instance in semi-modular groovebox (a phase was itself decomposed)

---

## 2. The Tiers in Detail

### 2.1 L0: Human User

The human acts as:
- **Orchestrator** — moves between tmux sessions, monitors progress, decides phase transitions
- **Tester** — runs the app between phases, verifies output is correct before proceeding
- **Quality gate** — approves plans before implementation begins
- **Message router** — tells L1/L2 coordinators what downstream workers produced
- **Domain expert** — provides design feedback, musical/UX judgment

**Trigger phrases** the human uses with L1:

| Phrase | Effect |
|--------|--------|
| `"wip"` / `"task status"` | Dashboard: tmux sessions, worktrees, Trello status, backlog |
| `"work on <card>"` / `"start working on X"` | Full spawn cycle (see §3) |
| `"start next"` | Pick first [NEXT]-tagged Trello card, spawn |
| `"finish task <name>"` | Merge, cleanup, Trello update |
| `"recover task <name>"` | Find worktree, recreate tmux, `claude --continue` |
| `"i'm bored"` | Suggest interesting tasks from Trello |
| Bug reports, design feedback | Fed into next phase prompt |

### 2.2 L1: Coordinator Session

A long-running Claude Code session in the **main worktree** (`/Users/azz/src/Morph`). Its responsibilities:

1. **Trello management** — card lookup, movement between lists, description updates
2. **Git orchestration** — worktree creation/removal, branch management, merging
3. **Session spawning** — tmux creation, prompt writing, Claude launching
4. **Progress tracking** — `wip` dashboards, stale task detection
5. **Cleanup** — kill tmux, remove worktrees, delete branches

The coordinator **never writes implementation code**. Its output is:
- Prompt files (`/tmp/<task>-prompt.md`)
- tmux/iTerm commands
- Git merge commands
- Trello API calls
- Status reports

**Observed coordinator sessions:**

| Session | Dates | Tasks Spawned | Merges | Peak Concurrency |
|---------|-------|---------------|--------|------------------|
| `44793b60` | Jan 31-Feb 1 | ~12 | ~8 | 3 parallel |
| `6dafb23d` | Feb 1-6 | ~20 | ~18 | 4 parallel |
| `d1a1dbe0` | Feb 11 | 9 | 4 | 3 parallel |
| `4a1bbdd7` | Feb 12-17 | ~25 | ~7 | 3 parallel |

Coordinator sessions are **long-lived** (days) and use `claude --continue` to resume across context exhaustion boundaries (up to 8 continuations observed).

### 2.3 The Worker: Two Modes in Detail

#### Implementer Mode (Feature Implementation Workflow)

When a worker determines the task fits in one context, it executes the Feature Implementation Workflow from the appropriate starting phase:

```
Worker (Implementer)
  ├── Phase 1: 4-5 parallel Explore sub-agents (deep research)
  ├── Phase 2: 2-3 cross-cutting analysis agents
  ├── Phase 3a: Plan document written (PLAN_<NAME>.md)
  ├── Phase 3b: 2-4 expert review agents (critic panel)
  ├── [STOP — wait for human approval]
  ├── Phase 4: Implementation (sequential sub-agents)
  ├── Phase 5: Verification agents
  └── Completion: commit + finish report
```

Workers can skip early phases when context is provided by their parent:
- Parent provides design doc → start at Phase 3 (planning) or Phase 4 (implementation)
- Parent provides research synthesis → start at Phase 2 (cross-cutting analysis)
- No prior context → start at Phase 1 (full research)

**Observed implementer metrics:**

| Feature | Sub-agents | Compactions | Commits | Duration |
|---------|------------|-------------|---------|----------|
| Quantized scene switching | 42 | 7 | 5 | ~90 min |
| Range faders | 23 | 4 | 2 | ~60 min |
| Mixer page | 17 | 3 | 5 | ~60 min |
| Bipolar faders | 13 | 2 | 1 | ~30 min |
| Sidechain pump | 17 | 1 | 1 | ~45 min |
| Dead code cleanup | 15 | 0 | 3 | ~45 min |

#### Coordinator Mode (Decompose + Spawn)

When a worker determines the task won't fit in one context, it becomes a coordinator:

```
Worker (Coordinator)
  ├── Research: Phase 1-2 (same as implementer — parallel Explore sub-agents)
  ├── Plan: Create phased IMPLEMENTATION_PLAN.md with explicit sub-tasks
  ├── Expert review: Spawn critic agents (architect, UX, DSP, musician)
  ├── [STOP — present plan to human for approval]
  │
  ├── For each phase:
  │     ├── Write phase prompt to /tmp/<phase>-prompt.md
  │     ├── Determine start_phase for child (research? planning? implementation?)
  │     ├── Spawn child Worker in tmux/iTerm
  │     ├── [WAIT — human tests child's output]
  │     └── Read completed code to inform next phase's prompt
  │
  └── Completion: verify all phases done, update plan, report
```

**Coordinator spawning patterns:**
- **Paired sessions per phase:** Design worker (creative/UX) + Implementation worker (code)
- **Parallel groups by scope:** 3 workers for synths/sequencers/effects simultaneously
- **Parallel groups by concern:** Board layout worker + Detail sheet worker
- **File ownership boundaries:** "Do NOT modify Source/UI/RackView.h (another worker is working on this)"

#### The Pivot

A worker may start in implementer mode (Phase 1 research), discover the task is too large, and **pivot to coordinator mode**. This is not a failure — it's the intended self-evaluation mechanism. The research done so far becomes the foundation for the decomposition plan.

---

## 3. The Spawn Cycle

When the human says "work on X", the coordinator executes this exact sequence:

### Step 1: Card Lookup
```
Trello MCP → search by name → match card → get details
```
Handles: 0 matches (fuzzy search), multiple matches (ask user), card already in Implementing (ask: resume or fresh?)

### Step 2: Git State Verification
```bash
git status --porcelain        # Must be clean
git worktree list             # Check for existing
git branch --list <name>      # Check for conflicts
```

### Step 3: Worktree + Branch Creation
```bash
git worktree add -b <type>/<description> /Users/azz/src/Morph-<name> main
```
Branch types: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `design/`

### Step 4: Submodule Copy
```bash
cp -r /Users/azz/src/Morph/JUCE ./JUCE
cp -r /Users/azz/src/Morph/lib/Open303 ./lib/Open303
cp -r /Users/azz/src/Morph/Libraries/DaisySP ./Libraries/DaisySP
```
Always these 3 directories. Worktrees lack submodules; local copy is faster than network fetch.

### Step 5: Tmux Session
```bash
tmux new-session -d -s <session-name> -c /path/to/worktree
tmux split-window -t <session-name> -v -p 30 -c /path/to/worktree
```
Two-pane layout: top 70% = Claude, bottom 30% = shell.

### Step 6: Prompt Construction + Delivery
Write prompt to `/tmp/<task>-prompt.md`, then:
```bash
tmux send-keys -t <session>:.1 "unset CLAUDECODE && cat /tmp/<task>-prompt.md | claude" Enter
```

### Step 7: iTerm Tab
```bash
osascript -e 'tell application "iTerm2" to tell current window to create tab...'
```

### Step 8: Trello Update
Move card to "Implementing", append metadata to description.

### Step 9: Report
Summary with worktree path, branch, tmux attach command.

---

## 4. The Prompt Template

Every L2 worker receives a prompt with this structure:

```markdown
## Task: <Card Title>

**Branch:** <type>/<description>
**Trello:** <card-url>
**Card Description:** <summary>

### Requirements / Technical Details
<task-specific content, often 50-100 lines>

---

## MANDATORY Feature Implementation Workflow

You are the COORDINATOR. Delegate to sub-agents, synthesize, integrate.
NEVER write code without completing Phases 1-3.

**Phase 1: Deep Research (MANDATORY)**
Spawn PARALLEL Analysis Agents (Task tool, subagent_type=Explore):
- Agent A: <specific files/scope for this task>
- Agent B: <specific files/scope for this task>
- Agent C: <specific files/scope for this task>
- Agent D: <optional domain expert>

**Phase 2: Cross-Cutting Analysis**
- Thread safety implications
- State flow and UI binding impacts
- Implicit dependencies

**Phase 3a: Draft Implementation Plan**
Create PLAN_<NAME>.md in Plans/

**Phase 3b: Expert Review Panel (MANDATORY)**
Spawn parallel review agents:
- Software Architect (ALWAYS)
- <Task-specific reviewers: UX/UI, DSP, Musician, Build Engineer>

STOP. Wait for user approval.

**Phase 4: Implementation**
Follow plan, build after each change: ./Scripts/build.sh

**Phase 5: Verification**
Review agents per module + cross-module.

**Completion**
On "finish task": verify build, update plan doc, commit, report.

---

**START NOW: Phase 1 (Deep Research). Spawn parallel Analysis Agents.**
```

### Template Variations

| Aspect | Standard | Variants |
|--------|----------|----------|
| Analysis agents | 4 (A-D) | 5 for complex tasks |
| Expert reviewers | 3 (Architect + UX + Musician) | +DSP for audio features, +Build for refactoring |
| Special phases | None | "Domain Expert Consultation" with mandatory user choice (sidechain-pump) |
| Workflow depth | Full 5-phase | Simplified 4-phase for polish/cleanup tasks |

### Key Adaptation Points

The template is **not mechanically copied** — the L1 coordinator adapts it per task:

1. **Agent scoping:** Each Analysis Agent gets specific files to read, not generic instructions
2. **Expert selection:** Reviewers chosen based on what the task touches
3. **Phase flexibility:** Polish tasks may drop Phase 3b; ambiguous tasks may add decision phases
4. **Context from prior work:** Prompts reference recently merged features and patterns to reuse

---

## 5. Recursive Coordination (Multi-Phase Projects)

### The Core Recursive Pattern

The architecture's power comes from L2's ability to self-evaluate and recurse:

```
L2 receives task from L1
  │
  ├─ Research phase (always): Deep codebase analysis
  │
  ├─ Decision point: Can I implement this in one context?
  │     │
  │     ├── YES → Execute Feature Implementation Workflow
  │     │         (becomes a leaf worker)
  │     │
  │     └── NO  → Create phased plan, become coordinator
  │               For each phase, spawn L3 in tmux/iTerm:
  │                 ├── Design/creative session (UX, mockups)
  │                 └── Implementation session (code)
  │               Human tests each phase before next proceeds
  │
  └─ Pivot scenario: Started as worker, realized task is too big
        → Write plan, switch to coordinator mode, spawn L3s
```

### Observed Instance: board-fader-columns (Depth 2)

Root worker acted as coordinator, spawning 14 child workers. Design and implementation workers were paired per phase:

```
L1: Dispatcher
  └── Worker[coordinator] — board-fader-columns
        ├── Worker[impl] — Phase A Research (start_phase=1)
        ├── Worker[impl] — Phase 1 Foundation (start_phase=4, plan provided)
        ├── Worker[impl] — Phase 1.5 HalfSheet Generalization (start_phase=4)
        ├── Worker[impl] — Phase 2 Connection Visualization (start_phase=4)
        ├── Worker[impl] — Phase 3a Tap-to-Connect (start_phase=4)
        ├── Worker[impl] — Phase 3b Mapping Editor (start_phase=4)
        ├── Worker[impl] — Phase 4 Fader HalfSheet (start_phase=4)
        ├── Worker[impl] — Phase 5 HalfSheet Redesign (start_phase=1) ← user tested, wasn't satisfied
        ├── Worker[impl] — Phase 6 Reimplementation (start_phase=4)
        ├── Worker[impl] — Bug Fix Session (start_phase=4)
        ├── Worker[impl] — Phase 6.5 Design (start_phase=1)
        └── Worker[impl] — Phase 6.5 Implementation (start_phase=4, design provided)
```

### Observed Instance: semi-modular-groovebox (Depth 2-3)

The largest project. Root worker as coordinator spawned 39 child workers, including parallel groups. One child itself became a coordinator (depth 3):

```
L1: Dispatcher
  └── Worker[coordinator] — semi-modular-groovebox
        ├── Worker[impl] — Design 1 (creative)    ─┐
        ├── Worker[impl] — Design 2 (creative)    ─┘ parallel
        ├── Worker[impl] — Consolidated Design (synthesis)
        ├── Worker[impl] — Phase A Stage 1 Foundation
        ├── Worker[impl] — Stage 2 synths      ─┐
        ├── Worker[impl] — Stage 2 sequencers  ─┤ parallel group
        ├── Worker[impl] — Stage 2 effects     ─┘
        ├── Worker[impl] — Stage 3 Integration
        ├── Worker[impl] — Phase B Routing      ─┐
        ├── Worker[impl] — Card UX Overhaul     ─┘ parallel
        ├── Worker[impl] — Phase C Modulation
        ├── Worker[impl] — Phase D Stages 1-3
        ├── Worker[impl] — Phase E (3 parallel by device type)
        ├── Worker[coordinator] — Phase F Polish  ← recursive! spawned its own children
        │     ├── Worker[impl] — sub-phase F.1
        │     └── Worker[impl] — sub-phase F.2
        ├── Worker[impl] — Phase G Review (start_phase=5, verification only)
        └── Worker[impl] — Phase H Cleanup
```

### Key Patterns for Parallel Worker Groups

**File ownership boundaries** prevent conflicts when workers run in parallel:
- "Do NOT modify Source/UI/RackView.h (another worker is working on this)"
- Each worker gets a specific file/module scope
- Parent coordinator specifies boundaries in the phase prompt

**Typical parallel groups:**
- 3 workers by device category (synths / sequencers / effects)
- 2 workers by concern (design worker + implementation worker)
- 2 workers by UI area (board layout + detail sheet)

---

## 6. Context Transfer Mechanisms

### Between Sessions (L1 → L2)

| Mechanism | Description | Reliability |
|-----------|-------------|-------------|
| **The codebase** | Workers read actual source files, including changes from previous phases | High — source of truth |
| **Prompt files** | `/tmp/<task>-prompt.md` with 200-400 lines of specification | High — self-contained |
| **Plan documents** | `Plans/PLAN_<NAME>.md` — canonical design reference | High — persists across sessions |
| **IMPLEMENTATION_PLAN.md** | Central status tracker for multi-phase projects | High — updated per phase |

### Within Sessions (L2 internal)

| Mechanism | Description |
|-----------|-------------|
| **Task tool sub-agents** | Explore/general-purpose agents for parallel work |
| **Coordinator synthesis** | L2 session synthesizes sub-agent findings before proceeding |
| **Context compaction** | Auto-triggered when context fills; loses detail but preserves structure |
| **`claude --continue`** | Resume from most recent session in working directory |

### Context Loss Points

| Point | What's Lost | Mitigation |
|-------|-------------|------------|
| Context compaction | Original sub-agent report details | Write key findings to plan doc before compaction |
| New session | All previous session context | Detailed prompt + plan doc + codebase as truth |
| L1 context exhaustion | Coordinator's accumulated state | `--continue` preserves summary; Trello/plan docs as external memory |

---

## 7. The Completion Cycle

### Worker Completion

When a worker finishes, it produces a **Finish Task Report**:

```
| Item | Status |
|------|--------|
| Build | Passed |
| Plan | Plans/PLAN_<NAME>.md — COMPLETED |
| Commit | <hash> on <branch> |
| Files changed | N files, +X / -Y lines |
| Docs updated | ARCHITECTURE.md, DEVELOPER_GUIDE.md |

Would you like me to merge to main, update Trello, or clean up?
```

### Coordinator Merge Flow

When the human says "finish task X":

1. Verify build in worktree
2. Merge to main: `git merge <branch> --no-ff -m "Merge <branch>: <description>"`
3. Update Trello: move card to Done, update description
4. Cleanup: `tmux kill-session`, `git worktree remove`, `git branch -d`
5. Report: merge status, commit hash, cleanup status

---

## 8. Evolution and Lessons Learned

### Prompt Delivery Evolution

| Phase | Method | Problem | When |
|-------|--------|---------|------|
| v1 | `tmux send-keys "claude \"$PROMPT\""` | Shell metacharacter mangling | Jan 31 |
| v2 | Heavy escaping of special chars | Unmaintainable, still fragile | Feb 1-5 |
| v3 | `Write → /tmp/prompt.md` + `cat \| claude` | **Solved** | Feb 6+ |

### Key Discoveries

| Discovery | Date | Impact |
|-----------|------|--------|
| `unset CLAUDECODE` required before nested launch | Feb 13 | Unblocked all tmux-based spawning |
| File-based prompts eliminate escaping | Feb 6 | Made reliable spawning possible |
| `pbcopy` fallback for failed send-keys | Feb 1 | Recovery mechanism for edge cases |
| Plan doc as shared state between sessions | Feb 13 | Enabled multi-phase coordination |
| File ownership boundaries for parallel agents | Feb 14 | Enabled safe parallelism in same worktree |

### Observed Pain Points

| Pain Point | Severity | Current Mitigation |
|------------|----------|-------------------|
| **Human is the only message bus** | High | None — user must manually relay between sessions |
| **Prompt writing is labor-intensive** | High | Template in CLAUDE.md; coordinator generates from template |
| **No automated progress monitoring** | Medium | User manually checks tmux; `wip` command |
| **Context exhaustion in coordinator** | Medium | `--continue` + Trello/plan docs as external memory |
| **Trello MCP token overflow** | Low | Read from disk file with offset/limit |
| **No automated testing gate** | Medium | User runs app manually between phases |
| **Parallel agent file conflicts** | Medium | Manual file ownership boundaries in prompts |

---

## 9. Quantitative Summary

| Metric | Value |
|--------|-------|
| Total sessions analyzed | 103 main + subagents |
| Worktrees used | 28 |
| Coordinator sessions | 5 (spanning weeks) |
| Worker sessions | ~60+ |
| Subagents within workers | ~500+ |
| Peak parallel workers | 4 |
| Largest single project | Semi-modular groovebox: 39 sessions, 171 subagents, 5 days |
| Plan documents created | ~45+ |
| Trello cards managed | ~50+ |
| Merges to main | ~45+ |
| Context continuations (coordinator) | Up to 8 per session |
| Prompt template size | 200-400 lines |

---

## 10. The Full Architecture Diagram

```
                      ┌───────────────────────────┐
                      │      Human (L0)            │
                      │                            │
                      │  Orchestrates, tests       │
                      │  output between every      │
                      │  worker transition          │
                      └─────────────┬──────────────┘
                                    │
                   "work on X" / "wip" / "finish task"
                                    │
           ┌────────────────────────▼────────────────────────┐
           │          L1: Dispatcher                         │
           │          (main worktree, long-lived)            │
           │                                                 │
           │  Trello MCP · Git · Tmux · iTerm · /tmp/*.md    │
           │  Never writes code. Spawns, merges, cleans up.  │
           └─────┬──────────┬──────────┬─────────────────────┘
                 │          │          │
          ┌──────▼───┐ ┌───▼────┐ ┌───▼────┐
          │Worker    │ │Worker  │ │Worker  │
          │[impl]   │ │[coord] │ │[impl]  │
          │         │ │        │ │        │
          │Feature  │ │Research│ │Feature │
          │Workflow │ │Plan    │ │Workflow│
          │Ph 1-5   │ │Spawn ──┤ │Ph 4-5  │  (start_phase=4,
          │         │ │        │ │        │   plan provided)
          │┌──────┐ │ │  ┌─────▼──────┐  │
          ││Task  │ │ │  │  Children   │  │
          ││tool  │ │ │  │             │  │
          ││agents│ │ │  │┌────┐┌────┐│  │
          │└──────┘ │ │  ││W   ││W   ││  │
          └─────────┘ │  ││impl││impl││  │
                      │  │└────┘└────┘│  │
                      │  │            │  │
                      │  │┌────┐      │  │
                      │  ││W   │← can │  │
                      │  ││cord│  recurse│
                      │  │└─┬──┘      │  │
                      │  │  │ ┌────┐  │  │
                      │  │  └─│W   │  │  │
                      │  │    │impl│  │  │
                      │  │    └────┘  │  │
                      │  └────────────┘  │
                      └──────────────────┘

Legend:
  Worker[impl]  = Implementer mode (Feature Implementation Workflow)
  Worker[coord] = Coordinator mode (decomposes, spawns children)
  W impl / W cord = same recursive unit at deeper levels
```

**The recursive decision (same at every depth):**
```
Worker(task, context, start_phase, remaining_splits):

  if remaining_splits == 0:
    execute_feature_workflow(task, start_phase)          # LEAF: must complete
    if context_exhausted: commit_wip(); STOP

  elif fits_in_one_context(evaluate_scope(task)):
    execute_feature_workflow(task, start_phase)          # Implementer

  else:
    plan = decompose_into_phases(task)                   # Coordinator
    for phase in plan.phases:
      spawn Worker(phase, sub_context,
                   determine_start_phase(phase),
                   remaining_splits - 1)                 # Decrement
      wait_for_human_test_and_approval()
```

**Communication flows (uniform at every depth):**
- Parent → Child: Prompt files via tmux send-keys (`/tmp/<phase>-prompt.md | claude`)
- Child → Human: User attaches to tmux to observe/test
- Human → Parent: "phase looks good" / "fix X" / bug reports
- Within any worker: Task tool sub-agents (Explore, general-purpose)

**Shared state:**
- Git repository (codebase as source of truth)
- Plan documents (`Plans/PLAN_*.md`) — written by coordinator workers, consumed by child workers
- Trello board (task status, managed by L1 dispatcher)

**Human's role at every transition:**
- Dispatcher → Worker: "start working on X"
- Coordinator → Child: Human tests coordinator's plan, approves, coordinator spawns child
- Child completes → Human tests → tells coordinator "phase done" → coordinator spawns next child
- All done → Human tells Dispatcher "finish task" → merge + cleanup

---

## 11. Identified Improvement Opportunities

### Automation Candidates

1. **Inter-session communication** — Currently human-mediated. Could be automated with file-based signaling or a lightweight message queue.

2. **Progress monitoring** — Currently manual tmux attachment. Could be automated with build status files or webhook notifications.

3. **Prompt generation** — Currently coordinator writes 200-400 line prompts. Could be templated with task-type-specific generators.

4. **Testing gates** — Currently human runs app manually. Could add automated build + smoke test between phases.

5. **Phase completion detection** — Workers produce structured finish reports but coordinator doesn't auto-detect them.

6. **File ownership enforcement** — Currently advisory ("Do NOT modify X"). Could be enforced via git hooks or file locks.

### Formalization Candidates

1. **The spawn cycle** — 9 steps, always the same. Should be a single command/skill.

2. **The prompt template** — Variations are predictable based on task type. Could be generated from a template + task metadata.

3. **The finish cycle** — merge + Trello + cleanup is always the same. Should be a single command.

4. **The wip dashboard** — Already well-defined but could be richer (build status, last commit time, context health).

5. **Phase transitions in multi-phase projects** — Currently manual. Could be semi-automated with a state machine in the plan document.

---

## 12. Context-Aware Self-Replication

### The Problem

A worker starts in implementer mode but may exhaust its context window before completing the task. Currently, this results in degraded output quality after compaction or requires manual human intervention to restart/split.

### The `fits_in_one_context` Decision Algorithm

**Implemented as a composite heuristic at Phase 2 → Phase 3 transition (the natural decision point):**

```
fits_in_one_context(research_findings):

  # TIER 1: Hard stops (instant disqualification)
  if compaction_count >= 2:           return FALSE  # "3 compaction rule"
  if plan_phase_count >= 5:           return FALSE  # too many phases
  if research_synthesis_tokens > 80K: return FALSE  # massive scope

  # TIER 2: Weighted scoring
  file_score    = min(1.0, files_to_modify / 15)      # >15 files → risky
  concern_score = cross_cutting_concern_complexity()    # thread safety, state, UI
  risk_score    = 0.3 * file_score + 0.7 * concern_score

  if risk_score > 0.6: return FALSE

  # TIER 3: Model self-judgment (tiebreaker)
  judgment = ask_model("Based on Phase 1-2 findings, can you complete
    implementation in ~120K remaining tokens?")
  if judgment == "too_large": return FALSE

  return TRUE
```

**Heuristic evaluation:**

| Signal | Feasibility | Reliability | Weight |
|--------|-------------|-------------|--------|
| Compaction count (>= 2) | HIGH — track via PreCompact hook | HIGH — empirical proof of overflow | Hard stop |
| Phase count in plan (>= 5) | HIGH — count sections in draft plan | MEDIUM — depends on granularity | Hard stop |
| Research token volume (> 80K) | HIGH — estimate from synthesis lines | HIGH — directly proportional to scope | Hard stop |
| Files to modify (> 15) | HIGH — count from research | MEDIUM — nonlinear relationship | 30% weight |
| Cross-cutting concerns | MEDIUM — classify from Phase 2 | HIGH — strong complexity predictor | 70% weight |
| Model self-judgment | HIGH — just ask | HIGH — model is good at this | Tiebreaker |

### When to Evaluate

The decision happens at **natural phase boundaries** (not mid-code-writing):

```
Phase 1 (Research) ──► Check: research volume too large?
                          │
Phase 2 (Analysis) ──► CRITICAL DECISION POINT: fits_in_one_context?
                          │
                    ┌─────┴──────┐
                    │            │
              fits=TRUE    fits=FALSE
                    │            │
              Phase 3-5    Become Coordinator
              (implement)  (write plan, spawn children)
```

**Embed in the worker's system prompt:**

```markdown
## CONTEXT CAPACITY CHECK (mandatory at Phase 2 completion)

After completing Phase 2 cross-cutting analysis, STOP and evaluate:

1. Research volume: Count lines in your Phase 1-2 synthesis
   - > 500 lines (~80K tokens) → SPLIT
   - 300-500 lines → continue to scoring

2. Cross-cutting concerns: Count distinct categories
   - Thread safety issues: ___
   - State management complexity: ___
   - UI/interaction changes: ___
   - If total > 3 high-complexity concerns → SPLIT

3. Phase count: How many implementation phases does the plan need?
   - >= 5 phases → SPLIT
   - 3-4 phases → continue to model judgment

4. Self-judgment: "Can I complete Phases 3-5 in ~120K remaining tokens?"
   - Output JSON: {"can_fit": bool, "confidence": "high"|"medium"|"low"}

If SPLIT: Immediately write IMPLEMENTATION_PLAN.md and ask human to approve
          coordinator mode with child worker spawning.
If FIT:   Proceed to Phase 3a plan draft.
```

### The Self-Replication Protocol (When `fits=FALSE`)

When a worker decides to split, it executes this exact sequence:

```
Worker realizes task won't fit
  │
  ├── [1] COMMIT Phase 1-2 checkpoint
  │     git add -A && git commit -m "WIP: Phase 2 complete — splitting to coordinator mode"
  │
  ├── [2] WRITE research synthesis
  │     Plans/FINDINGS_<TASK>.md  ← consolidated Phase 1-2 findings
  │     (this becomes context for child workers, saving them Phase 1-2 time)
  │
  ├── [3] WRITE implementation plan
  │     Plans/PLAN_<TASK>.md  ← phased breakdown with:
  │       - Phase boundaries
  │       - File ownership per phase
  │       - start_phase for each child (most get Phase 4)
  │       - Dependencies between phases
  │
  ├── [4] WRITE continuation prompts
  │     /tmp/phase-{N}-prompt.md for each phase, including:
  │       - Task scope and file boundaries
  │       - Key findings excerpt from FINDINGS doc
  │       - "Start at Phase {start_phase}"
  │       - "remaining_splits: {current - 1}"
  │       - Build verification commands
  │
  ├── [5] SIGNAL human
  │     "I've completed research and planning but this task is too large for
  │      one context. I've written N phase prompts. Ready to spawn child workers.
  │      Approve?"
  │
  ├── [WAIT for human approval]
  │
  ├── [6] SPAWN child workers in tmux/iTerm
  │     (using standard spawn mechanism: cat /tmp/prompt.md | claude)
  │
  └── [7] BECOME COORDINATOR for remaining phases
        - No longer writes implementation code
        - Reads completed code from children
        - Writes next phase prompts informed by previous phase output
        - Reports status to human between phases
```

### Controlled Recursion via `remaining_splits`

**Auto-splitting is allowed up to 2 levels deep.** The `remaining_splits` counter prevents infinite recursion:

```
L1 (Dispatcher) spawns with remaining_splits=2
  │
  └── Worker (remaining_splits=2)
        ├── fits? → implement directly
        └── too big? → split (remaining_splits=1 for children)
              │
              └── Worker (remaining_splits=1)
                    ├── fits? → implement directly
                    └── too big? → split ONE MORE TIME (remaining_splits=0 for children)
                          │
                          └── Worker (remaining_splits=0) — LEAF
                                └── MUST complete in one context
                                    If can't: commit WIP, write report, STOP
```

**Maximum tree depth: L1 → L2 → L3 → L4** (L4 is always a leaf).

**The `remaining_splits` parameter is passed in the phase prompt:**

```markdown
## Worker Configuration

remaining_splits: 1

If this task is too large for one context AND remaining_splits > 0:
- You MAY decompose into sub-phases and spawn child workers
- Pass remaining_splits={current - 1} to each child
- Children with remaining_splits=0 MUST complete in one context

If remaining_splits == 0:
- You MUST complete this task in one context
- If you run out of context: STOP, commit progress, write COMPLETION_REPORT.md
- Do NOT spawn child workers
```

**Safeguards against thrashing:**

1. **Coordinators must plan granular phases.** Each phase should target ~100K tokens of implementation. If a coordinator at `remaining_splits=1` creates 8 huge phases, its children (at `remaining_splits=0`) will fail. The coordinator must plan appropriately for leaf-level children.

2. **The "2 compaction rule" applies at every level.** Any worker that compacts 2+ times before reaching Phase 4 should evaluate splitting (if `remaining_splits > 0`) or stop and report (if `remaining_splits == 0`).

3. **Human still tests between every phase transition.** Auto-splitting doesn't remove the human from the loop — it just means the worker creates the plan and spawns children without being asked. The human still verifies each child's output before the next child starts.

### Compaction Monitoring Hook

Claude Code has a `PreCompact` hook. Use it for **metrics only** (not decision-making):

```json
// In ~/.claude/settings.json or project hooks
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"ts\":\"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'\",\"session\":\"'$SESSION_ID'\",\"source\":\"auto\"}' >> ~/.claude/compaction-metrics.jsonl"
          }
        ]
      }
    ]
  }
}
```

This builds a dataset of which tasks trigger compaction, informing future `fits_in_one_context` calibration.

**Why not use hooks for automated splitting:** Hooks can't access session history, token counts, or conversation state. They fire in isolation. The model's own self-evaluation (embedded in the system prompt) is more reliable because it has full context about the task, findings, and remaining work.

---

## 13. Expert Recommendations (Claude Code / AI Specialist Review)

### Ranked Improvements by Impact vs. Effort

#### Tier 1: Quick Wins (1-2 hours each, High Impact)

| # | Improvement | What | Impact |
|---|------------|------|--------|
| 1 | **Phase completion hook** | Post-command hook writes `/tmp/claude-phase-complete-*.json` signal files when worker outputs "Completion Report" | Eliminates manual tmux attachment for status checks |
| 2 | **Enhanced `/wip` dashboard** | Reads build.log + phase signals + stale task detection (no commit in 2h) | Replaces scattered manual checks |
| 3 | **Structured completion format** | YAML front matter in worker reports (machine-parseable status, artifacts, blockers) | Makes phase transitions automatable |
| 4 | **Prompt caching** | `cache_control: { type: "ephemeral" }` on ARCHITECTURE.md/CLAUDE.md in sub-agent system prompts | 50% cost reduction on repeated doc reads |

**Total: 6-8 hours for 40% friction reduction**

#### Tier 2: High-Value (3-6 hours each, Very High Impact)

| # | Improvement | What | Impact |
|---|------------|------|--------|
| 5 | **Session-bus MCP server** | Custom MCP for structured pub/sub messaging between sessions via file-based signals | Eliminates human-as-message-bus |
| 6 | **Tmux control MCP server** | Type-safe MCP wrapping tmux operations (create, send, capture, kill) | Eliminates shell escaping fragility |
| 7 | **`/spawn-worker` skill** | Single command replacing the 9-step spawn cycle | 15 commands → 1 |
| 8 | **Phase prompt generator** | Template system generating 250+ line prompts from task metadata + phase history | 30 min writing → 5 min review |
| 9 | **Git orchestration MCP** | Atomic worktree/branch/merge operations as MCP tools | Eliminates git bash parsing |

**Total: 14-20 hours for 60% coordinator labor reduction**

#### Tier 3: Strategic (8-12 hours each, Enables Full Automation)

| # | Improvement | What | Impact |
|---|------------|------|--------|
| 10 | **Coordinator Agent (SDK)** | 24/7 autonomous coordinator polling session-bus + Trello, auto-spawning/merging | Replaces long-running Claude Code coordinator |
| 11 | **Worker Agent (SDK)** | Autonomous Phase 1-5 agent with signal-based approval gates | Workers run without Claude Code UI |
| 12 | **Build automation** | Smoke test between phases with broadcast on success/fail | Replaces manual testing for regressions |

**Total: 30-40 hours for 80-90% automation (human approval gates preserved)**

### Target Architecture

```
┌─────────────────────────────────────────────────────┐
│  L0: Human User                                     │
│  (Strategic decisions, plan approval, UX testing)    │
│  Tests output between EVERY phase transition         │
└──────────────────────┬──────────────────────────────┘
                       │ "start next" / "approve plan" / test results
┌──────────────────────▼──────────────────────────────┐
│  L1: Coordinator Agent (SDK, 24/7, persistent)      │
│                                                      │
│  MCP Servers:                                        │
│  • session-bus (inter-session messages)              │
│  • tmux-control (session lifecycle)                  │
│  • git-orchestration (worktree/merge)                │
│  • trello (card management)                          │
│                                                      │
│  Capabilities:                                       │
│  • Auto-spawn L2 workers from Trello backlog         │
│  • Poll for completion signals from L2/L3/L4         │
│  • Auto-merge when human approves + tests pass       │
│  • Maintain persistent state (coordinator.db)        │
└──────────┬───────────┬───────────┬──────────────────┘
           │           │           │
    ┌──────▼──┐ ┌──────▼──┐ ┌─────▼───┐
    │L2 Small │ │L2 Large │ │L2 Large │
    │(Worker) │ │(Coord.) │ │(Coord.) │
    │         │ │         │ │         │
    │Feature  │ │Spawns   │ │Spawns   │
    │Workflow │ │L3s:     │ │L3s:     │
    │Phase1-5 │ │         │ │         │
    │         │ │┌──┐┌──┐│ │┌──┐┌──┐│
    │Signals: │ ││L3││L3││ ││L3││L3││
    │• done   │ ││  ││  ││ ││  ││  ││
    │• error  │ │└──┘└──┘│ │└──┘└──┘│
    └─────────┘ └────────┘ └────────┘
                     │
              (rare: L3→L4)
```

### Key Principles for Automation

1. **File-based signaling** — all inter-process communication via `/tmp/` files (robust, debuggable, survives restarts)
2. **Human approval preserved** — Phase 3b always halts for user review; coordinator never auto-approves plans
3. **Progressive deployment** — Tier 1 → Tier 2 → Tier 3 over 3-4 weeks; each tier is independently valuable
4. **Graceful degradation** — if any MCP server fails, workflow falls back to manual (current approach)

### Implementation Roadmap

- **Week 1:** Tier 1 — hooks, dashboard, structured reports, caching
- **Week 2:** Tier 2 — session-bus MCP, tmux MCP, spawn skill, prompt generator
- **Week 3-4:** Tier 3 — Coordinator Agent SDK, Worker Agent SDK, build automation
- **Checkpoint:** After Tier 2, coordinator labor drops to ~30 min/task (just approving plans)
