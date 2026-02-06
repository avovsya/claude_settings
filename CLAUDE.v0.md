# Global Claude Code Recipes

This file contains reusable workflows available in all Claude Code sessions.

---

## Working on Trello Cards

### Triggers

This workflow activates when user says:
- "start working on card/task <Name>"
- "work on <card name>"
- "work on next high priority item" / "work on next critical item" / "work on next P1"
- Similar variations

For "next high priority" requests: fetch cards with P1-Critical label from To Do list and pick the first one.

### Phase 1: Setup (Current Session)

**Step 1: Find the card**
```
Use Trello MCP to search for the card by name.
- If "next high priority": get cards with P1-Critical label from To Do list
- If 0 matches: suggest fuzzy search or ask for exact name
- If multiple matches: list them and ask user to specify
```

**Step 2: Verify card state**
```
- If card already in "Implementing" with branch recorded → ask: resume existing or start fresh?
- If card in "Done"/"Archived" → warn user and confirm intent
```

**Step 3: Verify git state**
```bash
git status --porcelain
# If uncommitted changes exist → warn user and stop
```

**Step 4: Create branch name**
```
- Extract kebab-case name from card title
- Format: <type>/<short-description> (max 50 chars)
- Types: feature/, fix/, refactor/, docs/
- If too long or invalid → suggest shorter name and confirm with user
```

**Step 5: Create worktree**
```bash
# Check if worktree/branch already exists
git worktree list | grep <branch-name>
git branch --list <branch-name>

# Create worktree and branch (use absolute path for worktree)
git worktree add -b <branch-name> /absolute/path/to/parent/<project>-<branch-name> main
```

**Step 6: Update Trello**
```
- Move card to "Implementing" list
- Append to card description:
  ---
  **Development:**
  - Branch: `<branch-name>`
  - Worktree: `../<project>-<branch-name>`
  - Started: <date>
```

**Step 7: Start Claude Code in tmux**

**Session naming:** Claude Code stores sessions per-directory at `~/.claude/projects/`.
Since each task has its own worktree (e.g., `Morph-stop-motion-button`), the Claude
session is effectively "named" by the task. Use `claude --continue` in the worktree
to resume, or `recover task <name>` if tmux is lost.

```bash
# Create tmux session in the new worktree
# Session name should match the task name for easy identification
tmux new-session -d -s <session-name> -c /absolute/path/to/worktree

# Split into two panes: top (70%) for Claude, bottom (30%) for shell
tmux split-window -t <session-name> -v -p 30 -c /absolute/path/to/worktree

# Pane layout after split:
#   Pane 1 (top, 70%): for Claude Code
#   Pane 2 (bottom, 30%): shell for git/build
```

**Step 8: Start Claude with initial prompt**

The prompt MUST include the FULL workflow instructions from Phase 2 below. Build it as follows:

```bash
# Build comprehensive prompt with full workflow instructions
PROMPT='## Task: <card-name>

**Branch:** <branch-name>
**Card Description:** <card-description-summary>

---

## MANDATORY Feature Implementation Workflow

**Discovery (Parallel Exploration)**
Launch multiple exploration agents simultaneously to investigate:
- Relevant existing code patterns and conventions
- Files that will need modification
- Dependencies and integration points
- Similar features already implemented (for consistency)
- Domain expert review if needed:
  - UX/UI expert for UI features
  - DSP engineer for audio processing
  - Architect for refactoring
  - Musician for musical features

**Planning**
Create PLAN_<FEATURE_NAME>.md in Plans/ folder covering:
- Architecture overview and design decisions
- Files to modify with specific changes
- Implementation order (dependencies first)
- Edge cases and how they are handled
- Get domain expert critique before proceeding
- Present plan for user approval before implementing

**Implementation**
- Follow the plan systematically using todo tracking
- Implement in dependency order
- Build and test after each major part: ./Scripts/build.sh
- Wait for user approval before continuing to next major phase

**Completion**
- When user says "finish task": verify build, update plan doc, commit changes, report summary

---

**START NOW: Begin Discovery phase. Use parallel exploration agents.**'

# Start Claude in top pane (pane 1) with the prompt
tmux send-keys -t <session-name>:.1 "claude \"$PROMPT\"" Enter
```

**Step 9: Open iTerm2 tab and attach to tmux session**
```bash
# Create new iTerm2 tab and attach to the tmux session
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

**Step 10: Return to user**
```
Output:
  ✓ Worktree created: ../<project>-<branch-name>
  ✓ Trello card moved to Implementing
  ✓ Claude Code started in tmux session

  To attach to the session:
    tmux attach -t <session-name>

  Panes:
    Top (pane 1): Claude Code working on the feature
    Bottom (pane 2): Shell for git/build commands

  Tmux shortcuts:
    Ctrl-b ↑/↓  - Switch panes
    Ctrl-b d    - Detach (session keeps running)
    tmux ls     - List sessions
```

---

## Feature Implementation Workflow (Inner Claude Session)

The inner Claude session follows this workflow:

### Discovery (Parallel Exploration)
```
Launch multiple exploration agents simultaneously to investigate:
- Relevant existing code patterns and conventions
- Files that will need modification
- Dependencies and integration points
- Similar features already implemented (for consistency)
- Domain expert review if needed:
  - UX/UI expert for UI features
  - DSP engineer for audio processing
  - Architect for refactoring
  - Musician for musical features
```

### Planning
```
Create PLAN_<FEATURE_NAME>.md in Plans/ folder covering:
- Architecture overview and design decisions
- Files to modify with specific changes
- Implementation order (dependencies first)
- Edge cases and how they're handled
- Get domain expert critique before proceeding
- Present plan for user approval before implementing
```

### Implementation
```
- Follow the plan systematically using todo tracking
- Implement in dependency order
- Build and test after each major part
- Wait for user approval before continuing to next major phase
```

### Completion
```
- When user says "finish task": run the Finish Task workflow below
```

### Key Principles

- **Explore in parallel, implement sequentially**
- **Write the plan first, get approval, then code**
- **Match existing codebase patterns**
- **Handle edge cases explicitly in the plan**
- **Build frequently** to catch issues early

---

## Finish Task Workflow

### Triggers

This workflow activates when user says:
- "finish task"
- "complete task"
- "done with this task"
- Similar variations

### Steps

**Step 1: Verify build passes**
```bash
./Scripts/build.sh  # or project-specific build command
# If build fails → fix issues first, don't proceed
```

**Step 2: Update plan document**
```
- Mark PLAN_<FEATURE_NAME>.md as complete
- Add "Status: COMPLETED" and completion date
- Document any deviations from original plan
```

**Step 3: Commit all changes**
```bash
git add -A
git commit -m "<type>: <description>

<detailed summary of changes>

Plan: Plans/PLAN_<FEATURE_NAME>.md
Trello: <card-url>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

**Step 4: Update Trello card**
```
- Move card to "Testing" or "Done" list (ask user which)
- Update card description with results:
  ---
  **Completed:**
  - Date: <date>
  - Plan: `Plans/PLAN_<FEATURE_NAME>.md`
  - Commits: <commit-hash>
  - Status: Ready for testing / Merged
```

**Step 5: Merge to main (if requested)**
```bash
# Switch to main branch in main worktree
cd /path/to/main/worktree
git checkout main
git merge <feature-branch> --no-ff -m "Merge <branch-name>: <description>"
```

**Step 6: Cleanup (optional, ask user)**
```bash
# Remove the feature worktree
git worktree remove /path/to/feature/worktree

# Delete the feature branch (if merged)
git branch -d <branch-name>

# Kill the tmux session
tmux kill-session -t <session-name>
```

**Step 7: Report to user**
```
Output:
  ✓ Build verified
  ✓ Plan document updated: Plans/PLAN_<FEATURE_NAME>.md
  ✓ Changes committed: <commit-hash>
  ✓ Trello card moved to <list-name>
  ✓ Merged to main (if applicable)
  ✓ Cleanup completed (if applicable)

  Summary:
    - Files changed: <count>
    - Lines added: <count>
    - Lines removed: <count>
```

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
│  tmux session                                           │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Pane 1 (top 70%): Claude Code                     │  │
│  │   Discovery → Planning → Implementation           │  │
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

## Task Status Workflow

### Triggers

This workflow activates when user says:
- "wip" / "wip status"
- "task status"
- "what am I working on"
- Similar variations

### Steps

**Step 1: Gather data**
```
1. Get cards from Trello "Implementing" list
2. List active tmux sessions
3. Check for PLAN_*.md files in worktrees
4. Get high priority cards from "To Do" list (P1-Critical, P2-High labels)
```

**Step 2: Display Active Tasks table**
```
Show table with columns:
| Task | Priority | tmux Session | Branch | Worktree | Plan | Phase |

Phase is determined by:
- "Discovery" if no PLAN file exists
- "Planning" if PLAN file exists but not approved
- "Implementation" if commits exist after plan
- "Completed" if merged
```

**Step 3: Display Stale Tasks**
```
Cards in "Implementing" without active tmux session or recent activity.
Suggest cleanup or resumption.
```

**Step 4: Display High Priority Backlog (for "task status" trigger)**
```
Show remaining P1-Critical and P2-High items from To Do list.
| Task | Priority | Type |
```

**Step 5: Show quick actions**
```
Suggest:
- "attach to <session>" to resume work
- "start working on <card>" for backlog items
- "finish task" if work is complete
- "recover task <name>" if tmux session was lost
```

---

## Recover Task Workflow

### Triggers

This workflow activates when user says:
- "recover task <name>"
- "resume task <name>"
- "restore session <name>"
- Similar variations

### Background

Claude Code stores sessions per-worktree directory at:
`~/.claude/projects/-<path-with-dashes>/<session-id>.jsonl`

Since each task has its own worktree (e.g., `Morph-stop-motion-button`), sessions are effectively "named" by task.

### Steps

**Step 1: Find the worktree**
```bash
# Search for worktree matching task name
git worktree list | grep -i "<task-name>"

# Or list all Morph worktrees
ls -d /Users/azz/src/Morph-*/ | grep -i "<task-name>"
```

**Step 2: Verify Claude session exists**
```bash
# Check if session files exist for this worktree
WORKTREE_PATH="/Users/azz/src/Morph-<task-name>"
PROJECT_DIR=$(echo "$WORKTREE_PATH" | sed 's|/|-|g' | sed 's|^-||')
ls ~/.claude/projects/${PROJECT_DIR}/*.jsonl 2>/dev/null
```

**Step 3: Check if tmux session exists**
```bash
tmux list-sessions | grep -i "<task-name>"
```

**Step 4a: If tmux session exists but Claude not running**
```bash
# Attach to tmux and start Claude with --continue
tmux attach -t <session-name>
# Then in tmux pane 1:
claude --continue
```

**Step 4b: If tmux session doesn't exist**
```bash
# Recreate tmux session
tmux new-session -d -s <session-name> -c /Users/azz/src/Morph-<task-name>
tmux split-window -t <session-name> -v -p 30 -c /Users/azz/src/Morph-<task-name>

# Start Claude with --continue to resume the previous session
tmux send-keys -t <session-name>:.1 "claude --continue" Enter

# Open iTerm2 tab and attach
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

**Step 5: Report to user**
```
Output:
  ✓ Found worktree: /Users/azz/src/Morph-<task-name>
  ✓ Found Claude session: <session-id>
  ✓ Recreated tmux session: <session-name>
  ✓ Resumed Claude Code with previous context

  iTerm2 tab opened and attached to session.
```

### Notes

- `claude --continue` resumes the most recent session in the current directory
- `claude --resume <session-id>` resumes a specific session by UUID
- Session files are at: `~/.claude/projects/-Users-azz-src-Morph-<task-name>/`
- If multiple sessions exist, use `claude --resume` with interactive picker

---

## "I'm Bored" Workflow

### Triggers

This workflow activates when user says:
- "i'm bored"
- "what should I work on"
- "pick something fun"
- "surprise me"
- Similar variations

### Steps

**Step 1: Gather exciting tasks from multiple sources**
```
1. High priority (P1-Critical) bugs and features from To Do
2. Recently added cards (last 7 days)
3. Fun ideas from "Freezebox and Ideas" list
4. Any tasks with interesting/experimental descriptions
```

**Step 2: Categorize and present**
```
Show in sections:
- 🔥 HOT (P1-Critical, recently added)
- 🐛 BUGS (quick wins, satisfying fixes)
- 🎨 FUN FEATURES (creative, experimental)
- 🧊 COOL IDEAS (from Freezebox - wild/ambitious)
- 🎲 RANDOM PICK (one surprise suggestion)
```

**Step 3: For each suggestion, include**
```
- Card name and link
- One-line "why it's cool" description
- Estimated complexity hint (quick/medium/deep dive)
```

**Step 4: Offer quick actions**
```
- "start working on <card>" for any suggestion
- "tell me more about <card>" for details
- "shuffle" for different suggestions
```

### Selection Criteria for "Cool"

- Has interesting technical challenge
- Visible/satisfying result
- Experimental or creative
- Performance/music-focused
- Recently brainstormed (fresh idea energy)
