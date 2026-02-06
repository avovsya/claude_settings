# CLAUDE.md Reference Companion

This is a human-readable reference companion to `CLAUDE.md`. Agents should not read this unless specifically asked.

---

## Structure Map: What's in CLAUDE.md and Why

| Section | Purpose | Notes |
|---------|---------|-------|
| **Working on Trello Cards** | Outer session setup: find card, create worktree/branch, update Trello, launch tmux + inner Claude | Steps 1-10 executed by the session where user says "work on X" |
| **Step 8 (embedded prompt)** | Injected instructions for the inner Claude session | This is the actual text sent to Claude in the worktree. Contains the full 5-phase workflow. Keep compact — it's a payload |
| **Feature Workflow Reference** | How the Coordinator (inner session) should behave | Agent roles, sub-agent discipline, phase summaries. The inner session uses this to understand the architecture |
| **Finish Task** | Wrap-up procedure: build, plan doc, commit, Trello, merge, cleanup | Triggered by user saying "finish task" in any context |
| **Task Status** | Dashboard: what's in progress, what's stale, what's in backlog | Triggered by "wip" or "task status" |
| **Recover Task** | Restore a lost tmux session and resume Claude context | Uses `claude --continue` to pick up where it left off |
| **"I'm Bored"** | Fun task picker from Trello backlog and ideas | Categorizes by excitement/complexity |

### Why two files?

`CLAUDE.md` is loaded into the agent's system prompt every session. Every token counts. Diagrams, examples, and explanations waste context window on things agents don't need. This reference file holds the human-readable versions for when you want to understand or modify the workflows.

---

## Agent Roles

| Role | Tool | Purpose |
|------|------|---------|
| **Coordinator** | Main Claude session | Plans phases, delegates to sub-agents, synthesizes findings, integrates changes. Never writes code blindly. |
| **Analysis Agent** | Task (subagent_type=Explore) | Deep-reads every file in a scoped area. Reports: public API, internal state, threading model, connections to other modules. |
| **Implementation Agent** | Task (subagent_type=general-purpose) | Writes code in a focused module following the approved plan. Reports: files changed, lines added/removed, potential cross-module impacts. |
| **Review Agent** | Task (subagent_type=Explore) | Verifies changes for correctness, consistency with codebase conventions, thread safety, and absence of regressions. |

---

## Workflow Diagram

```
┌─────────────────────────────────────────────────────────┐
│  "work on card X" / "work on next P1"                   │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Current Claude Session (Setup)                         │
│  1. Find card in Trello                                 │
│  2. Create worktree + branch                            │
│  3. Update Trello (move to Implementing)                │
│  4. Start tmux with Claude + prompt                     │
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
│  │  Phase 3: Plan → USER APPROVAL GATE                │  │
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

### Phase 3: Implementation Plan

Coordinator writes `PLAN_<FEATURE_NAME>.md` in `Plans/` using findings from Phase 1 & 2.

**Plan must include:**
- Architecture overview and design decisions (with rationale from research)
- Specific files and classes to modify, with what changes and why
- Implementation order (dependencies first)
- Cross-cutting concerns from Phase 2 and how each is handled
- Edge cases and error handling strategy
- Thread safety approach (if applicable)
- Testing strategy

**Optional plan critique:**
```
Agent H: "Review this implementation plan as a <domain expert>. Identify gaps,
         risks, or better approaches. Be specific and critical."
```

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
