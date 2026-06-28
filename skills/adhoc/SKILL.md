---
name: adhoc
description: "Spawn a worker session for a quick task without a Trello card. Handles git worktree creation, tmux worker-window setup (a window in the project's session), worker prompt generation, and Claude launch. Use when: 'adhoc research X', 'adhoc refactor Y', or any request to begin work on a task that doesn't have a Trello card."
argument-hint: "<task-description> [--splits N] [--phase N]"
user-invocable: true
---

# /adhoc

Spawn a new worker session for an ad-hoc task — no Trello card required. This is a lightweight version of `/spawn-worker` for quick tasks, experiments, and one-off work.

## Parse Arguments

Extract from `$ARGUMENTS`:

```
$ARGUMENTS = <task-description> [--splits N] [--phase N]
```

- **Task description:** Everything before the first `--` flag. This is a free-text description of the task (may be quoted or unquoted).
- **`--splits N`** (default: 0): Sets `remaining_splits` for the worker. 0 = leaf (must complete in one context), 1 = can split once, 2 = can split twice.
- **`--phase N`** (default: 1): Sets `start_phase`. 1=Research, 2=Cross-Cutting, 3=Planning, 4=Implementation, 5=Verification.

If `$ARGUMENTS` is empty, ask the user to describe the task.

---

## Step 1: Verify Git State

Run in the current working directory:

```bash
git status --porcelain
```

If there is any output (uncommitted changes), STOP and warn:

> Uncommitted changes detected. Commit or stash before spawning a worker.

List the changed files. Do NOT proceed.

If clean, continue.

---

## Step 2: Create Branch Name

Generate a branch name from the task description:

1. Always use prefix `adhoc/`.
2. Extract key words from the task description: drop stop words (a, an, the, to, for, how, in, on, with, and, or, is, it, of, that, this), lowercase everything.
3. Convert to kebab-case: replace spaces and special characters with hyphens, collapse multiple hyphens, trim leading/trailing hyphens.
4. Combine: `adhoc/<key-words>`
5. Truncate to 50 characters max (trim at last complete word before limit).

**Examples:**
- `"research how MCP servers handle authentication"` → `adhoc/research-mcp-servers-handle-authentication`
- `"refactor the tmux executor to use async/await"` → `adhoc/refactor-tmux-executor-use-async-await`
- `"fix the broken import in types.ts"` → `adhoc/fix-broken-import-types-ts`

If the resulting name looks awkward or too long, suggest it to the user and ask for confirmation. Accept user override.

---

## Step 3: Create Worktree

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

## Step 4: Copy Submodules

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

## Step 5: Create Worker Window

Workers are **windows in the project's single tmux session**, not standalone sessions (one server, one session per project, one window per worker — continuum saves the whole server).

Determine the **project session** (the session the dispatcher is already in — e.g. `Cheeky`), falling back to the project basename if not inside tmux. Derive the worker id/window name from the branch:

```bash
if [ -n "$TMUX" ]; then
  PROJECT_SESSION=$(tmux display-message -p -t "${TMUX_PANE:-}" '#S')   # e.g. Cheeky
else
  PROJECT_SESSION=$(basename "$MAIN_WORKTREE" | tr ' .' '__')           # tmux dislikes '.'/':' in names
fi
WORKER_ID=$(echo '<branch-name>' | tr '/' '-')                          # window name + prompt-file key
```

Ensure the project session exists, then check for a window-name collision:

```bash
tmux has-session -t "$PROJECT_SESSION" 2>/dev/null \
  || tmux new-session -d -s "$PROJECT_SESSION" -c "$MAIN_WORKTREE"

tmux list-windows -t "$PROJECT_SESSION" -F '#{window_name}' | grep -Fxq "$WORKER_ID"
```

If that window already exists, ask the user: attach to it, or kill and recreate (`tmux kill-window -t "$PROJECT_SESSION:$WORKER_ID"`)?

Create the worker window (top pane Claude / bottom shell), `-d` so it does not steal focus:

```bash
tmux new-window -d -t "$PROJECT_SESSION" -n "$WORKER_ID" -c "$WORKTREE_PATH"
tmux split-window -t "$PROJECT_SESSION:$WORKER_ID" -v -p 30 -c "$WORKTREE_PATH"
```

Pane 1 (top, 70%): Will run Claude Code.
Pane 2 (bottom, 30%): Shell for manual commands.

---

## Step 6: Write Prompt and Launch Claude

### Generate the prompt file

Write the worker prompt to `/tmp/<worker-id>-prompt.md` using the Worker Prompt Template below. Replace all `<placeholders>` with actual values.

### Validate the prompt

```bash
test -s "/tmp/<worker-id>-prompt.md"
```

If empty or missing, something went wrong — report the error.

### Launch Claude in tmux

**Critical:** Must `unset CLAUDECODE` to prevent parent session environment from leaking into the child worker.

```bash
tmux send-keys -t "$PROJECT_SESSION:$WORKER_ID".1 "unset CLAUDECODE && cat /tmp/<worker-id>-prompt.md | claude" Enter
```

(`.1` targets the top pane — `pane-base-index` is 1 in this tmux config.)

---

## Step 7: Report

No iTerm2 tab is opened (the worker is a window in the already-attached project session — just switch to it). Output a summary:

```
Ad-hoc worker spawned for: <task-description>
  Worktree: <worktree-path>
  Branch:   <branch-name>
  Splits:   <remaining_splits>, Phase: <start_phase>

  Session: <project-session>   Window: <worker-id>
  Reach it:  C-a C-l / C-a C-h  (cycle worker windows in the current session)
  Or attach: tmux attach -t <project-session> \; select-window -t <worker-id>
  Panes:     Top = Claude Code | Bottom = shell  (C-a h/j/k/l to move; C-a d to detach)
```

---

## Worker Prompt Template

This is the exact content written to `/tmp/<worker-id>-prompt.md`. Replace all `<placeholders>` with actual values from the steps above.

````markdown
## Task: <task-description>

**Branch:** <branch-name>
**Worktree:** <worktree-path>

### Requirements

<task-description>

---

## Worker Configuration

session_id: <worker-id>
remaining_splits: <remaining_splits>
start_phase: <start_phase>

You are operating under the Recursive Worker Model.
<if remaining_splits == 0>This is a leaf worker (remaining_splits=0) — you MUST complete in one context.<endif>
<if remaining_splits > 0>
- Phase 1: Deep Research (mandatory before any code)
- Phase 2: Cross-Cutting Analysis → then run Context Capacity Check
- Phase 3a: Draft Implementation Plan, 3b: Expert Review Panel (mandatory before user sees plan)
- Phase 4: Implementation (sequential, coordinator reviews each agent output)
- Phase 5: Verification (parallel review agents)

At Phase 2 completion, run the Context Capacity Check.
If this task requires splitting, follow the Self-Replication Protocol.
<endif>

Follow the **Recursive Worker Model** defined in your global CLAUDE.md.

---

**START NOW: Begin Phase <start_phase> (<phase-name>). <start-instruction>**
````

**Phase name mapping:**
- 1 → "Deep Research"
- 2 → "Cross-Cutting Analysis"
- 3 → "Planning"
- 4 → "Implementation"
- 5 → "Verification"

**Start instruction mapping** (adjust the final line based on start_phase):
- Phase 1: "Spawn parallel Analysis Agents."
- Phase 2: "Spawn cross-cutting Analysis Agents."
- Phase 3: "Draft the implementation plan in Plans/."
- Phase 4: "Begin implementation following the approved plan."
- Phase 5: "Spawn parallel Review Agents for verification."
