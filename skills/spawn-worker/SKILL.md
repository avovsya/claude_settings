---
name: spawn-worker
description: "Spawn a worker session for a Trello card. Handles card lookup, git worktree creation, tmux session setup, worker prompt generation, and Claude launch. Use when: 'start working on card X', 'work on X', 'spawn worker for X', 'work on next P1', or any request to begin work on a Trello card in a new session."
argument-hint: "<card-name-or-url> [--splits N] [--phase N]"
user-invocable: true
---

# /spawn-worker

Spawn a new worker session for a Trello card. This is the Dispatcher (L1) workflow — orchestration only, never implementation code.

## Parse Arguments

Extract from `$ARGUMENTS`:

```
$ARGUMENTS = <card-identifier> [--splits N] [--phase N]
```

- **Card identifier:** Everything before the first `--` flag. May be a card name (with spaces), a Trello URL, or the keyword `next`.
- **`--splits N`** (default: 2): Sets `remaining_splits` for the worker. 0 = leaf (must complete), 1 = can split once, 2 = can split twice.
- **`--phase N`** (default: 1): Sets `start_phase`. 1=Research, 2=Cross-Cutting, 3=Planning, 4=Implementation, 5=Verification.

If `$ARGUMENTS` is empty, ask the user what card to work on.

---

## Step 1: Find Card

**If card identifier is `next`:**
Search Trello for P1-Critical cards in the "To Do" list. Pick the first one.

**If card identifier is a Trello URL:**
Extract the card ID from the URL and fetch it directly via Trello MCP.

**If card identifier is a name:**
Search Trello by name via MCP.

**Handle results:**
- **0 matches:** Try a fuzzy/partial search. If still 0, ask the user to clarify.
- **1 match:** Use it.
- **Multiple matches:** List all matches with board name, list name, and labels. Ask the user to select one.

Store: card name, card ID, card URL, card description, card labels, current list name, board name.

---

## Step 2: Verify Card State

Check the card's current list:

- **Already in "Implementing" or "Researching":** Check if the card description contains a branch name or worktree path. If so, ask the user: "This card is already in progress with branch `<branch>`. Resume existing session, or start fresh?"
  - Resume: run the Recover Task workflow instead (see global CLAUDE.md).
  - Fresh: continue with Steps 3+.
- **In "Done" or "Archived":** Warn: "This card is marked as Done/Archived. Proceed anyway?" Wait for confirmation.
- **Any other list (To Do, Testing, etc.):** Proceed normally.

---

## Step 3: Verify Git State

Run in the current working directory:

```bash
git status --porcelain
```

If there is any output (uncommitted changes), STOP and warn:

> Uncommitted changes detected. Commit or stash before spawning a worker.

List the changed files. Do NOT proceed.

If clean, continue.

---

## Step 4: Create Branch Name

Generate a branch name from the card title:

1. Determine type prefix from card labels or title keywords:
   - Labels containing "bug" or "fix" → `fix/`
   - Labels containing "refactor" → `refactor/`
   - Labels containing "docs" or "documentation" → `docs/`
   - Default → `feature/`
2. Convert card title to kebab-case: lowercase, replace spaces and special characters with hyphens, collapse multiple hyphens, trim leading/trailing hyphens.
3. Combine: `<type>/<kebab-title>`
4. Truncate to 50 characters max (trim at last complete word before limit).

If the resulting name looks awkward or too long, suggest it to the user and ask for confirmation. Accept user override.

---

## Step 5: Create Worktree

Derive paths:

```bash
MAIN_WORKTREE=$(git worktree list | head -1 | awk '{print $1}')
PARENT_DIR=$(dirname "$MAIN_WORKTREE")
PROJECT=$(basename "$MAIN_WORKTREE")
WORKTREE_PATH="${PARENT_DIR}/${PROJECT}-$(echo '<branch-name>' | tr '/' '-')"
```

Check for conflicts:

```bash
git worktree list | grep "<branch-name>"
git branch --list "<branch-name>"
```

- **Branch exists + worktree exists:** Ask user — use existing, or remove and recreate?
- **Branch exists, no worktree:** Ask user — reuse branch (create worktree for it), or delete branch and start fresh?
- **Neither exists:** Proceed.

Create:

```bash
git worktree add -b <branch-name> "$WORKTREE_PATH" main
```

---

## Step 6: Copy Submodules

Check if the project uses submodules:

```bash
test -f "${MAIN_WORKTREE}/.gitmodules" && echo "HAS_SUBMODULES" || echo "NO_SUBMODULES"
```

**If no submodules:** Skip this step.

**If submodules exist:** Parse submodule paths from `.gitmodules` and copy each from the main worktree:

```bash
grep 'path = ' "${MAIN_WORKTREE}/.gitmodules" | sed 's/.*path = //' | while read -r subpath; do
  if [ -d "${MAIN_WORKTREE}/${subpath}" ]; then
    mkdir -p "$(dirname "${WORKTREE_PATH}/${subpath}")"
    cp -R "${MAIN_WORKTREE}/${subpath}" "${WORKTREE_PATH}/${subpath}"
  fi
done
```

If any copy fails, warn the user and ask whether to continue without that submodule or stop.

---

## Step 7: Update Trello

Determine target list:
- If card is on the **Curiosity Lab** board → move to "Researching" list
- Otherwise → move to "Implementing" list

Move the card via Trello MCP.

Append to the card description:

```
---
**Worker Session**
- Branch: `<branch-name>`
- Worktree: `<worktree-path>`
- Started: <YYYY-MM-DD>
- Splits: <remaining_splits>, Phase: <start_phase>
```

---

## Step 8: Start tmux

Derive session name from branch name (replace `/` with `-`):

```bash
SESSION_NAME=$(echo '<branch-name>' | tr '/' '-')
```

Check for existing session:

```bash
tmux has-session -t "$SESSION_NAME" 2>/dev/null
```

If exists, ask user: attach to existing, or kill and recreate?

Create session with 2-pane layout:

```bash
tmux new-session -d -s "$SESSION_NAME" -c "$WORKTREE_PATH"
tmux split-window -t "$SESSION_NAME" -v -p 30 -c "$WORKTREE_PATH"
```

Pane 1 (top, 70%): Will run Claude Code.
Pane 2 (bottom, 30%): Shell for manual commands.

---

## Step 9: Write Prompt and Launch Claude

### Generate the prompt file

Write the worker prompt to `/tmp/<session-name>-prompt.md` using the Worker Prompt Template below. Replace all `<placeholders>` with actual values.

### Validate the prompt

```bash
test -s "/tmp/<session-name>-prompt.md"
```

If empty or missing, something went wrong — report the error.

### Launch Claude in tmux

**Critical:** Must `unset CLAUDECODE` to prevent parent session environment from leaking into the child worker.

**Critical:** Must use `--dangerously-skip-permissions` to eliminate permission prompts. See [Permission Model](#permission-model) below.

```bash
tmux send-keys -t "$SESSION_NAME":.1 "unset CLAUDECODE && cat /tmp/<session-name>-prompt.md | claude --dangerously-skip-permissions" Enter
```

---

## Step 10: Open iTerm2 Tab

```bash
osascript <<'APPLESCRIPT'
tell application "iTerm2"
    tell current window
        create tab with default profile
        tell current session
            write text "tmux attach -t <session-name>"
        end tell
    end tell
end tell
APPLESCRIPT
```

If iTerm2 is not running or the osascript fails, skip this step silently. The user can always attach manually.

---

## Step 11: Report

Output a summary:

```
Worker spawned for: <card-name>
  Worktree: <worktree-path>
  Branch:   <branch-name>
  Trello:   <card-url> (moved to <target-list>)
  Splits:   <remaining_splits>, Phase: <start_phase>

  Attach: tmux attach -t <session-name>
  Panes:  Top = Claude Code | Bottom = shell
          Ctrl-b up/down to switch | Ctrl-b d to detach
```

---

## Permission Model

Workers are launched with `--dangerously-skip-permissions` to achieve zero permission prompts during autonomous operation.

**What this means:**
- All permission checks are bypassed — file edits, bash commands, git operations, MCP calls auto-approved
- The deny list in `~/.claude/settings.json` is also bypassed for the worker session
- The dispatcher session is NOT affected — it retains standard permission prompts

**Why this is safe:**
- Workers run in isolated git worktrees on dedicated feature branches
- Workers cannot affect the main branch without an explicit dispatcher merge
- Workers don't push to remote (dispatcher handles merges)
- Claude has built-in safety constraints regardless of permission settings
- Workers are short-lived (hours, not days)

**To disable for a specific worker:** Remove `--dangerously-skip-permissions` from the launch command above. The worker will revert to standard permission prompts governed by `~/.claude/settings.json`.

**If Claude Code updates break this:** Verify the flag exists via `claude --help` and update the launch command accordingly.

---

## Worker Prompt Template

This is the exact content written to `/tmp/<session-name>-prompt.md`. Replace all `<placeholders>` with actual values from the steps above.

````markdown
## Task: <card-name>

**Branch:** <branch-name>
**Trello:** <card-url>
**Card Description:**
<card-description — first ~500 words, or full if shorter>

**Labels:** <comma-separated labels, or "None">

### Requirements

<card-description content that describes what to build — this is the full card description>

---

## Worker Configuration

session_id: <session-name>
remaining_splits: <remaining_splits>
start_phase: <start_phase>

You are operating under the Recursive Worker Model:
- Phase 1: Deep Research (mandatory before any code)
- Phase 2: Cross-Cutting Analysis → then run Context Capacity Check
- Phase 3a: Draft Implementation Plan, 3b: Expert Review Panel (mandatory before user sees plan)
- Phase 4: Implementation (sequential, coordinator reviews each agent output)
- Phase 5: Verification (parallel review agents)

Follow the **Recursive Worker Model** defined in your global CLAUDE.md.
At Phase 2 completion, run the Context Capacity Check.
If this task requires splitting, follow the Self-Replication Protocol.

## Permission Model

You are running with `--dangerously-skip-permissions` — all permission checks are bypassed.
This is safe because you are in an isolated worktree on a feature branch.
Exercise normal judgment — avoid destructive commands, don't modify files outside your worktree.

---

**START NOW: Begin Phase <start_phase> (<phase-name>). <start-instruction>**
````

**Phase name mapping:**
- 1 → "Deep Research"
- 2 → "Cross-Cutting Analysis"
- 3 → "Planning"
- 4 → "Implementation"
- 5 → "Verification"

**Start instruction mapping** (for `<start-instruction>` in the final line):
- Phase 1: "Spawn parallel Analysis Agents."
- Phase 2: "Spawn cross-cutting Analysis Agents."
- Phase 3: "Draft the implementation plan in Plans/."
- Phase 4: "Begin implementation following the approved plan."
- Phase 5: "Spawn parallel Review Agents for verification."
