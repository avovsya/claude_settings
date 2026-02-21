---
name: coord-spawn
description: "Spawn a worker session via the coordinator daemon. Handles daemon auto-start, Trello card lookup, spawn request submission, and confirmation polling. Use when: 'coord spawn X', 'use coordinator for X', 'spawn via coordinator', or any request to spawn a worker through the coordinator daemon."
argument-hint: "<card-name-or-url> [--splits N] [--phase N]"
user-invocable: true
---

# /coord-spawn

Spawn a worker session via the coordinator daemon. The daemon handles worktree creation, tmux setup, and Claude launch. This skill submits a spawn request and confirms the worker appeared.

## Parse Arguments

Extract from `$ARGUMENTS`:

```
$ARGUMENTS = <card-identifier> [--splits N] [--phase N]
```

- **Card identifier:** Everything before the first `--` flag. May be a card name (with spaces), a Trello URL, or the keyword `next`.
- **`--splits N`** (default: 2): Sets `remaining_splits` for the worker.
- **`--phase N`** (default: 1): Sets `start_phase`. 1=Research, 2=Cross-Cutting, 3=Planning, 4=Implementation, 5=Verification.

If `$ARGUMENTS` is empty, ask the user what card to work on.

---

## Step 1: Detect Main Worktree

```bash
MAIN_WORKTREE=$(git worktree list | head -1 | awk '{print $1}')
```

Store this — the coordinator needs it as `--main-worktree`.

---

## Step 2: Find Card (if `next`)

**If card identifier is `next`:**
Use Trello MCP to search for P1-Critical cards in the "To Do" list. Pick the first one. Store the card name, ID, and URL.

**If card identifier is a Trello URL:**
Extract the card short-link from the URL (the part after `/c/`). Store as `card_url`.

**If card identifier is a name:**
Store as `card_name` — the coordinator will do its own Trello search.

---

## Step 3: Ensure Coordinator is Running

### Check PID file

```bash
COORD_DIR="$HOME/.claude/coordinator"
PID_FILE="$COORD_DIR/coordinator.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "RUNNING:$PID"
  else
    echo "STALE"
    rm -f "$PID_FILE"
  fi
else
  echo "NOT_RUNNING"
fi
```

### If running: proceed to Step 4.

### If not running (or stale): auto-start the daemon.

**Build if needed:**

```bash
if [ ! -f "$COORD_DIR/build/index.js" ]; then
  echo "Building coordinator..."
  (cd "$COORD_DIR" && npm install && npm run build)
fi
```

**Extract Trello credentials from `~/.claude/mcp.json`:**

```bash
MCP_JSON="$HOME/.claude/mcp.json"
TRELLO_API_KEY="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$MCP_JSON','utf8')).mcpServers.trello.env.TRELLO_API_KEY || '')")"
TRELLO_TOKEN="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$MCP_JSON','utf8')).mcpServers.trello.env.TRELLO_TOKEN || '')")"
```

If either is empty, STOP and tell the user to configure Trello credentials in `~/.claude/mcp.json`.

**Clean stale state:**

```bash
rm -f "$PID_FILE"
```

**Launch daemon in tmux session `coord-daemon`:**

```bash
# Kill stale tmux session if it exists
tmux kill-session -t coord-daemon 2>/dev/null || true

# Create tmux session
tmux new-session -d -s coord-daemon -c "$MAIN_WORKTREE" \
  -e "TRELLO_API_KEY=$TRELLO_API_KEY" \
  -e "TRELLO_TOKEN=$TRELLO_TOKEN"

# Start daemon in top pane
tmux send-keys -t coord-daemon "node $COORD_DIR/build/index.js --main-worktree $MAIN_WORKTREE --log-level debug" Enter

# Bottom pane: interactive shell for coord commands
tmux split-window -t coord-daemon -v -p 40 -c "$MAIN_WORKTREE" \
  -e "TRELLO_API_KEY=$TRELLO_API_KEY" \
  -e "TRELLO_TOKEN=$TRELLO_TOKEN"
```

**Wait for startup (up to 5s):**

```bash
for i in 1 2 3 4 5; do
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Coordinator started (PID $(cat "$PID_FILE"))"
    break
  fi
  sleep 1
done
```

If still not running after 5s, STOP and report the error. Suggest checking `tmux attach -t coord-daemon` for logs.

---

## Step 4: Submit Spawn Request

Write a JSON file to the spawn-requests directory. The coordinator polls this directory and picks up new requests.

**Build the JSON:**

```json
{
  "card_name": "<card-name or null>",
  "card_id": "<card-id or null>",
  "card_url": "<card-url or null>",
  "remaining_splits": <splits>,
  "start_phase": <phase>,
  "requested_at": "<ISO 8601 timestamp>"
}
```

At least one of `card_name`, `card_id`, or `card_url` must be set.

**Write it:**

```bash
SPAWN_DIR="$HOME/.claude/coordinator/spawn-requests"
mkdir -p "$SPAWN_DIR"
TIMESTAMP=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")

cat > "$SPAWN_DIR/${TIMESTAMP}.json" <<'SPAWN_JSON'
<the JSON object>
SPAWN_JSON
```

---

## Step 5: Poll for Confirmation

Check `coord status` every 10s (up to 30s) to confirm the worker appeared.

```bash
COORD_CMD="node $HOME/.claude/coordinator/build/cli/coord.js"

for i in 1 2 3; do
  sleep 10
  STATUS_OUTPUT=$($COORD_CMD status 2>&1 || true)
  echo "$STATUS_OUTPUT"
  # Check if the card name or a new worker session appears
  if echo "$STATUS_OUTPUT" | grep -qi "<card-name-fragment>"; then
    echo "Worker confirmed!"
    break
  fi
done
```

If the worker doesn't appear after 30s, that's OK — the coordinator may pick it up on the next poll cycle (default 30s). Report: "Spawn request submitted. The coordinator will pick it up within 30s."

---

## Step 6: Open iTerm2 Tab (if worker session known)

If the poll in Step 5 revealed a tmux session name for the worker:

```bash
osascript <<'APPLESCRIPT'
tell application "iTerm2"
    tell current window
        create tab with default profile
        tell current session
            write text "tmux attach -t <worker-session-name>"
        end tell
    end tell
end tell
APPLESCRIPT
```

If iTerm2 is not running or session name is unknown, skip silently.

---

## Step 7: Report

Output a summary:

```
Coordinator spawn requested for: <card-name>
  Daemon:   PID <pid> in tmux session 'coord-daemon'
  Request:  <spawn-request-file>
  Status:   <confirmed | pending pickup (up to 30s)>

  Daemon attach:  tmux attach -t coord-daemon
  Worker attach:  tmux attach -t <worker-session> (when spawned)
  Coord status:   node ~/.claude/coordinator/build/cli/coord.js status
```

---

## Key Differences from /spawn-worker

| Aspect | `/spawn-worker` | `/coord-spawn` |
|--------|-----------------|----------------|
| Worktree creation | Dispatcher creates directly | Coordinator daemon creates |
| tmux setup | Dispatcher creates directly | Coordinator daemon creates |
| Claude launch | Dispatcher launches in tmux | Coordinator daemon launches |
| Daemon required | No | Yes (auto-started) |
| Poll delay | Immediate | Up to 30s |
| Trello update | Dispatcher via MCP | Coordinator via REST API |
| Best for | Single tasks, quick spawns | Multi-worker coordination, persistent daemon |
