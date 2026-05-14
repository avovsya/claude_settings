---
name: codex-worker
description: "Spawn a worker session using the OpenAI Codex CLI for a Trello card. Handles card lookup, git worktree creation, tmux session setup, prompt file writing, and Codex launch. Use when: 'spawn codex for X', 'use codex for X', 'codex worker for X', 'start codex on X', or any request to work on a Trello card using Codex instead of Claude."
argument-hint: "<card-name-or-url>"
user-invocable: true
---

# /codex-worker

Spawn a Codex CLI session for a Trello card. Same worktree + tmux setup as `/spawn-worker` but launches `codex` instead of `claude`.

## Parse Arguments

Extract card identifier from `$ARGUMENTS`. May be a card name, Trello URL, or `next`.

---

## Step 1: Load Trello Credentials

```bash
key=$(jq -r '.mcpServers.trello.env.TRELLO_API_KEY // empty' ~/.claude/mcp.json)
token=$(jq -r '.mcpServers.trello.env.TRELLO_TOKEN // empty' ~/.claude/mcp.json)
board=${MORPH_TRELLO_BOARD_ID:-6918a0395d374f16d643d975}
```

If either is empty, stop and tell the user credentials are missing in `~/.claude/mcp.json`.

---

## Step 2: Find Card

Use Trello MCP to find the card (same as `/spawn-worker` Step 1). Resolve name/URL/`next`. Confirm with user if multiple matches.

---

## Step 3: Verify Git State

```bash
git diff --quiet && git diff --cached --quiet || echo "DIRTY"
```

Warn if dirty. Abort only if user confirms.

---

## Step 4: Create Branch + Worktree

```bash
MAIN_WORKTREE=$(git worktree list | head -1 | awk '{print $1}')
PARENT_DIR=$(dirname "$MAIN_WORKTREE")
PROJECT=$(basename "$MAIN_WORKTREE")

branch="<type>/<kebab-card-title>"          # e.g. fix/scene-switch-skip
worktree="${PARENT_DIR}/${PROJECT}-<kebab>"  # e.g. ../Morph-fix-scene-switch-skip
session="<kebab-card-title>"                 # tmux session name

git worktree add -b "$branch" "$worktree" main
```

Copy submodules if `.gitmodules` exists (same as spawn-worker).

---

## Step 5: Write Prompt File

Write task prompt to `/tmp/<session>-codex-prompt.md`. Use a single-quoted heredoc to avoid shell interpolation of backticks:

```bash
cat > /tmp/${session}-codex-prompt.md <<'PROMPT'
## Task

<card title and URL>

## Context

- Branch: <branch>
- Worktree: <worktree>
- Main repo: <main worktree path>

## Required Reading

- CLAUDE.md (project rules)
- docs/ARCHITECTURE.md (if exists)
- Plans/PLAN_*.md (if a plan exists for this task)

## Objective

<card description — paste full text>

## Constraints

- Build must pass: `./Scripts/build.sh`
- Follow thread safety rules from CLAUDE.md
- Commit with plan/Trello refs

## Done When

<clear completion criteria>
PROMPT
```

---

## Step 6: Create tmux Session

```bash
tmux new-session -d -s "$session" -c "$worktree"
tmux split-window -t "$session" -v -p 30 -c "$worktree"
```

Top pane (70%): Codex. Bottom pane (30%): shell.

---

## Step 7: Launch Codex

Find the top pane by `pane_top` value (do NOT assume window/pane index 0):

```bash
top_pane="$(tmux list-panes -t "$session" -F '#{pane_id} #{pane_top}' \
  | sort -k2,2n | awk 'NR==1{print $1}')"

tmux send-keys -t "$top_pane" \
  "cd '$worktree' && codex \"Read /tmp/${session}-codex-prompt.md and execute it.\"" \
  Enter
```

---

## Step 8: Update Trello

- Move card to **Implementing**
- Post comment (use `printf` for multiline, then `--data-urlencode`):

```bash
text="$(printf 'Codex worker session started.\n- Branch: %s\n- Worktree: %s\n- Session: %s\n- Prompt: /tmp/%s-codex-prompt.md\n- Attach: tmux attach -t %s' \
  "$branch" "$worktree" "$session" "$session" "$session")"

curl -sS --fail -X POST \
  "https://api.trello.com/1/cards/${card_id}/actions/comments" \
  --data-urlencode "key=${key}" \
  --data-urlencode "token=${token}" \
  --data-urlencode "text=${text}"
```

---

## Step 9: Attach iTerm2 Tab

```bash
osascript <<EOF
tell application "iTerm2"
  tell current window
    create tab with default profile
    tell current session
      write text "tmux attach -t $session"
    end tell
  end tell
end tell
EOF
```

Graceful fallback: if iTerm2 not available or fails, just report the attach command.

---

## Step 10: Report

```
Card:     <title> — <url>
Branch:   <branch>
Worktree: <worktree>
Session:  <session>
Prompt:   /tmp/<session>-codex-prompt.md
Attach:   tmux attach -t <session>
Trello:   → Implementing
```

---

## Guardrails

**tmux:** Always discover pane by `pane_top` sort — never assume index 0.

**Trello multiline comments:** Always `printf` + `--data-urlencode`. Never literal `\n` strings.

**Prompt file:** Always single-quoted heredoc (`<<'PROMPT'`) to prevent backtick/variable interpolation.

**Credential check:** If `key` or `token` is empty after the jq extract, stop immediately.
