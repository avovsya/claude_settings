# CLAUDE.md Reference Companion

This is a human-readable reference companion to `CLAUDE.md`. Agents should not read this unless specifically asked.

---

## Structure Map: What's in CLAUDE.md and Why

| Section | Purpose | Notes |
|---------|---------|-------|
| **Working on Trello Cards** | Entry point: `/spawn-worker` skill automates the full setup cycle | Invoked by user with card name/URL. See `skills/spawn-worker/SKILL.md` for the 11-step process |
| **Worker Prompt Template** | Template written to `/tmp/<session>-prompt.md` and piped to Claude | Defined in the skill. Contains task context + Recursive Worker Model reference + start trigger |
| **Feature Workflow Reference** | How the Coordinator (inner session) should behave | Agent roles, sub-agent discipline, phase summaries. The inner session uses this to understand the architecture |
| **Finish Task** | Wrap-up procedure: build, plan doc, commit, Trello, merge, cleanup | Triggered by user saying "finish task" in any context |
| **Task Status** | Dashboard: active tasks with build status, phase progress, stale detection (2h), context health (compaction count) | Triggered by "wip" or "task status" |
| **Recover Task** | Restore a lost tmux session and resume Claude context | Uses `claude --continue` to pick up where it left off |
| **"I'm Bored"** | Fun task picker from Trello backlog and ideas | Categorizes by excitement/complexity |

### Why multiple files?

- `CLAUDE.md` — loaded into the agent's system prompt every session. Every token counts. Kept lean.
- `CLAUDE_REFERENCE.md` — human-readable companion with diagrams and examples.
- `skills/spawn-worker/SKILL.md` — the `/spawn-worker` skill with full step-by-step instructions for the spawn cycle.
- `rules/` — persistent checklist rules loaded into every session.

---

## Agent Roles

| Role | Tool | Purpose |
|------|------|---------|
| **Coordinator** | Main Claude session | Plans phases, delegates to sub-agents, synthesizes findings, integrates changes. Never writes code blindly. |
| **Analysis Agent** | Task (subagent_type=Explore) | Deep-reads every file in a scoped area. Reports: public API, internal state, threading model, connections to other modules. |
| **Domain Expert** | Task (subagent_type=Explore) | Critiques the implementation plan as a specialist. Spawned in Phase 3b based on task scope. See expert types below. |
| **Implementation Agent** | Task (subagent_type=general-purpose) | Writes code in a focused module following the approved plan. Reports: files changed, lines added/removed, potential cross-module impacts. |
| **Review Agent** | Task (subagent_type=Explore) | Verifies changes for correctness, consistency with codebase conventions, thread safety, and absence of regressions. |

### Domain Expert Types

| Expert | When to spawn | What they critique |
|--------|---------------|-------------------|
| **Software Architect** | ALWAYS | Structural soundness, coupling, patterns, API design, separation of concerns |
| **Thread Safety Reviewer** | Concurrency / shared state | Races, deadlocks, synchronization strategy, actor isolation |
| **UX/UI Expert** | UI changes | Layout, interaction patterns, accessibility, visual consistency |
| **DSP Engineer** | Audio / signal processing | Latency, buffer handling, real-time safety, algorithm correctness |
| **Musician** | Musical features | Workflow feel, musical correctness, creative utility, musician expectations |

---

## Workflow Diagram

```
┌─────────────────────────────────────────────────────────┐
│  "work on card X" / "work on next P1"                   │
│  → /spawn-worker <card-name> [--splits N] [--phase N]   │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  /spawn-worker Skill (Dispatcher Session)               │
│  1. Find card in Trello (MCP search)                    │
│  2. Verify card state + git clean                       │
│  3. Create branch + worktree                            │
│  4. Copy submodules (if .gitmodules exists)              │
│  5. Update Trello (move to Implementing)                │
│  6. Start tmux (2-pane: 70% Claude / 30% shell)         │
│  7. Write prompt → /tmp/<session>-prompt.md              │
│  8. Launch: unset CLAUDECODE && cat prompt | claude      │
│  9. Open iTerm2 tab (auto-attach)                       │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  tmux session — Coordinator (Claude Code)               │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Pane 1 (top 70%): Claude Code (Coordinator)       │  │
│  │                                                    │  │
│  │  Phase 1: Deep Research                            │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │  │
│  │  │Analysis A│ │Analysis B│ │Analysis C│ parallel  │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘          │  │
│  │       └─────────────┼───────────┘                 │  │
│  │                     ▼                              │  │
│  │  Phase 2: Cross-Cutting Analysis                   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │  │
│  │  │Thread Saf│ │State Flow│ │Dep Check │ parallel  │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘          │  │
│  │       └─────────────┼───────────┘                 │  │
│  │                     ▼                              │  │
│  │  Phase 3a: Draft Plan                               │  │
│  │                     ▼                              │  │
│  │  Phase 3b: Expert Review Panel                     │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │  │
│  │  │Architect │ │DSP/Thread│ │UX/Music  │ parallel  │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘          │  │
│  │       └─────────────┼───────────┘                 │  │
│  │                     ▼                              │  │
│  │  Incorporate feedback → USER APPROVAL GATE         │  │
│  │                     ▼                              │  │
│  │  Phase 4: Implementation (sequential, reviewed)    │  │
│  │  ┌──────────┐    ┌──────────┐                     │  │
│  │  │Impl Agt 1│───▶│Impl Agt 2│───▶ ...            │  │
│  │  └──────────┘    └──────────┘                     │  │
│  │                     ▼                              │  │
│  │  Phase 5: Verification                             │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │  │
│  │  │Review A  │ │Review B  │ │Cross-mod │ parallel  │  │
│  │  └──────────┘ └──────────┘ └──────────┘          │  │
│  │                                                    │  │
│  ├───────────────────────────────────────────────────┤  │
│  │ Pane 2 (bottom 30%): Shell                        │  │
│  │   git, build commands                             │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  "finish task"                                          │
│  1. Verify build                                        │
│  2. Update plan doc                                     │
│  3. Commit changes                                      │
│  4. Update Trello (move to Done)                        │
│  5. Merge to main                                       │
│  6. Cleanup worktree/branch/tmux                        │
└─────────────────────────────────────────────────────────┘
```

---

## Phase-by-Phase Reference with Example Agent Prompts

### Phase 1: Deep Research

Spawn parallel Analysis Agents. Each gets a focused scope and must read every file within it.

**Example prompts:**

```
Agent A: "Read every file in <ModuleX>. Report: public API, internal state,
         threading model, how it connects to other modules."

Agent B: "Find all existing implementations of <similar pattern> in the codebase.
         Report: conventions used, file structure, naming patterns."

Agent C: "Trace the data flow for <relevant feature>. Report: entry points,
         transformations, where state is stored, UI bindings."

Agent D (domain expert, if needed):
  - UX/UI expert for UI features
  - DSP engineer for audio processing
  - Architect for refactoring
  - Musician for musical features
```

Coordinator waits for all agents, then synthesizes findings into a unified understanding. The gate question: "What exists today, and how does it work?"

### Phase 2: Cross-Cutting Analysis

Spawn targeted Analysis Agents for concerns that cut across modules.

**Example prompts:**

```
Agent E: "Given we plan to modify <X, Y, Z>, analyze thread safety implications.
         Which operations touch shared state? What synchronization exists?"

Agent F: "Analyze how changes to <Module> will affect state flow and UI bindings.
         Trace from model → view model → view for all affected properties."

Agent G: "Check for implicit dependencies — notifications, KVO, delegate callbacks,
         global state — that could break if <Module> changes."
```

Coordinator synthesizes into a risk assessment: what could go wrong, what needs careful handling.

### Phase 3a: Draft Implementation Plan

Coordinator writes `PLAN_<FEATURE_NAME>.md` in `Plans/` using findings from Phase 1 & 2.

**Plan must include:**
- Architecture overview and design decisions (with rationale from research)
- Specific files and classes to modify, with what changes and why
- Implementation order (dependencies first)
- Cross-cutting concerns from Phase 2 and how each is handled
- Edge cases and error handling strategy
- Thread safety approach (if applicable)
- Testing strategy

### Phase 3b: Expert Review Panel (MANDATORY)

Before presenting the plan to the user, spawn parallel Domain Expert agents to critique it. The Coordinator selects which experts are relevant based on what the task touches.

**Example prompts:**
```
Architect: "Review this plan as a software architect. Evaluate: structural
           soundness, coupling between components, API design, separation of
           concerns. Are there better patterns? Is anything over-engineered
           or under-engineered?"

Thread Safety: "Review this plan for concurrency issues. Evaluate: shared state
               access, synchronization strategy, potential races or deadlocks,
               actor isolation boundaries. Is the threading model sound?"

UX/UI: "Review this plan as a UX/UI expert. Evaluate: interaction patterns,
        layout consistency with existing UI, accessibility, animation/feedback,
        edge cases in user flow."

DSP: "Review this plan as a DSP engineer. Evaluate: real-time safety (no
      allocations in audio thread?), buffer handling, latency implications,
      algorithm correctness, numerical stability."

Musician: "Review this plan as a musician and producer. Evaluate: does the
          workflow feel natural? Is the musical behavior correct? Would this
          be useful in a real session? Any creative use cases missed?"
```

Coordinator incorporates feedback into the plan, then presents the final version to the user.

**This is a hard gate: present plan to user, wait for approval before any code.**

### Phase 4: Implementation

Execute the plan in dependency order. Each major area gets a focused Implementation Agent.

**Example prompt:**
```
Agent I: "Implement <specific change> in <specific files> following this approach:
         <excerpt from plan>. Report: files changed, lines added/removed,
         anything that might affect other modules."
```

Coordinator reviews each agent's output before spawning the next. Build after each major part (`./Scripts/build.sh`). Get user approval between major phases.

### Phase 5: Verification

Spawn parallel Review Agents to independently verify the implementation.

**Example prompts:**
```
Agent J: "Review all changes in <Module A>. Verify: matches the plan, no regressions,
         thread safety preserved, consistent with codebase conventions."

Agent K: "Review all changes in <Module B>. Check for: consistency with Module A changes,
         correct state flow, UI bindings still valid."

Agent L: "Do a cross-module review. Verify: no broken dependencies, notifications
         still work, no state leaks between modules."
```

Coordinator synthesizes review findings. If issues found, fix before proceeding to Finish Task.

---

## Version History

| Version | File | Description |
|---------|------|-------------|
| v0 | `CLAUDE.v0.md` | Original flat workflow (Discovery → Planning → Implementation) |
| v1 | `CLAUDE.v1.md` | Hierarchical 5-phase agent architecture added |
| v2 | `CLAUDE.md` + `CLAUDE_REFERENCE.md` | Split into agent-optimized ops + human reference |
| v2.1 | same files | Phase 3 split into 3a (draft) + 3b (mandatory expert review panel) |
