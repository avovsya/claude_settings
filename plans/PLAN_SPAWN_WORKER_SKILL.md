# Plan: /spawn-worker Skill

**Status:** Complete (2026-02-20)
**Branch:** feature/spawn-worker-skill
**Trello:** https://trello.com/c/IMOeGXhp/3-7-spawn-worker-skill

---

## Architecture Overview

Create a single-file Claude Code skill at `skills/spawn-worker/SKILL.md` that replaces the 10-step manual spawn cycle. The skill is a markdown instruction document (not a shell script) that tells Claude how to execute each step using available tools (Bash, Trello MCP, etc.).

### Key Design Decisions

1. **File-based prompt delivery** — Write worker prompt to `/tmp/<task>-prompt.md`, deliver via `cat | claude`. This is the production-proven approach (evolved through 3 iterations, validated across 103 sessions).

2. **Reference global CLAUDE.md, don't duplicate** — Workers will have the global CLAUDE.md loaded automatically. The prompt references "Recursive Worker Model defined in your global CLAUDE.md" instead of inlining the full 5-phase workflow. This keeps prompts compact and ensures workers always use the latest workflow version.

3. **Detect project config at runtime** — Submodules detected from `.gitmodules`. Build commands from project CLAUDE.md. No hardcoded project paths.

4. **Derive paths from git worktree** — Main worktree, parent dir, and project name all derived from `git worktree list`. Session names derived from branch name.

5. **Handle both Trello boards** — Main board for feature/fix/refactor tasks, Curiosity Lab board for research tasks. Detected from card's board context.

---

## File to Create

### `skills/spawn-worker/SKILL.md`

**~250-350 lines** of YAML frontmatter + imperative markdown instructions.

**Structure:**

```
---
YAML frontmatter (name, description, argument-hint, user-invocable, etc.)
---

## Argument Parsing
Parse $ARGUMENTS for card name/URL, --splits N, --phase N

## Step 1: Find Card
Trello MCP search, handle 0/multiple/next

## Step 2: Verify Card State
Check implementing/done/archived

## Step 3: Verify Git State
git status --porcelain

## Step 4: Create Branch Name
Kebab-case, typed prefix, max 50 chars

## Step 5: Create Worktree
git worktree add, check existing

## Step 6: Copy Submodules (if applicable)
Read .gitmodules, copy from main worktree

## Step 7: Update Trello
Move to Implementing/Researching, append metadata

## Step 8: Start tmux
2-pane layout (70/30)

## Step 9: Write Prompt + Launch Claude
Generate /tmp/<task>-prompt.md, cat | claude

## Step 10: Open iTerm2 Tab
osascript to create tab and attach

## Step 11: Report
Summary with attach command

## Worker Prompt Template
The exact template written to /tmp/<task>-prompt.md
```

---

## Implementation Details

### YAML Frontmatter

```yaml
name: spawn-worker
description: "Spawn a worker session for a Trello card — handles card lookup, git worktree, tmux, prompt generation, and Claude launch. Trigger on: 'start working on', 'work on card', 'spawn worker', 'work on next P1'."
argument-hint: "<card-name-or-url> [--splits N] [--phase N]"
user-invocable: true
```

### Argument Parsing

- `$ARGUMENTS` contains the full argument string
- Parse card identifier: everything before first `--` flag, or the entire string
- Parse `--splits N` (default: 2) — maps to remaining_splits
- Parse `--phase N` (default: 1) — maps to start_phase
- Special value "next" — fetch next P1-Critical card from To Do list

### Worker Prompt Template

The prompt written to `/tmp/<task>-prompt.md` will contain:

```markdown
## Task: <card-name>

**Branch:** <branch-name>
**Trello:** <card-url>
**Card Description:** <summary>

### Requirements
<card description content>

---

## Worker Configuration

remaining_splits: <N>
start_phase: <N>

You are operating under the Recursive Worker Model:
- Phase 1: Deep Research (mandatory before code)
- Phase 2: Cross-Cutting Analysis → Context Capacity Check
- Phase 3a: Draft Plan, 3b: Expert Review Panel (mandatory)
- Phase 4: Implementation (sequential, reviewed)
- Phase 5: Verification

Follow the **Recursive Worker Model** defined in your global CLAUDE.md.
At Phase 2 completion, run the Context Capacity Check.
If this task requires splitting, follow the Self-Replication Protocol.

---

**START NOW: Phase <N> (<phase-name>). Spawn parallel Analysis Agents.**
```

Phase names: 1=Deep Research, 2=Cross-Cutting Analysis, 3=Planning, 4=Implementation, 5=Verification.

### Launch Command (Step 9)

**Critical:** Must `unset CLAUDECODE` before nested launch to prevent parent session environment from leaking into child:

```bash
tmux send-keys -t <session-name>:.1 "unset CLAUDECODE && cat /tmp/<task>-prompt.md | claude" Enter
```

### Project-Specific Config Detection

**Submodules:**
- Run `test -f .gitmodules` in main worktree
- If exists, parse paths and copy each from main worktree to new worktree
- Handles: JUCE, lib/Open303, Libraries/DaisySP (Morph) and any future projects

**Build commands:**
- Not needed during spawn — worker discovers from project CLAUDE.md at runtime

### Trello Board Handling

- Search for card across all boards the user has access to
- If card is on Curiosity Lab board: move to "Researching" list instead of "Implementing"
- Append to card description: Branch, Worktree path, Started date

### Error Handling (all conditional branches)

| Condition | Action |
|-----------|--------|
| 0 card matches | Fuzzy search, then ask user |
| Multiple card matches | List all matches, ask user to select |
| Card in "Implementing" with branch | Ask: resume existing or start fresh? |
| Card in "Done"/"Archived" | Warn user, confirm before proceeding |
| Uncommitted git changes | Warn and STOP |
| Branch already exists | Ask: reuse or create new? |
| Worktree already exists | Ask: use existing or recreate? |
| tmux session exists | Kill and recreate, or attach to existing |
| iTerm2 not running | Skip tab creation, print attach command |

---

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `skills/spawn-worker/SKILL.md` | CREATE | The skill document (~300 lines) |
| `plans/PLAN_SPAWN_WORKER_SKILL.md` | CREATE | This plan |

---

## Testing Strategy

After creating the skill:
1. Verify YAML frontmatter parses correctly (check with `/help` or skill list)
2. Test with a real Trello card name
3. Test with "next" argument
4. Test error paths (dirty git, existing branch)
5. Verify worker prompt file is well-formed
6. Verify tmux + iTerm integration works
