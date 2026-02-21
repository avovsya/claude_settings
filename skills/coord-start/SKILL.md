---
name: coord-start
description: "Start, check, or stop the coordinator daemon. Handles building, Trello credential extraction, tmux session management, and daemon lifecycle. Use when: 'start coordinator', 'coord start', 'stop coordinator', 'coordinator status', or any request to manage the coordinator daemon."
argument-hint: "[--stop]"
user-invocable: true
---

# /coord-start

Start, check, or stop the coordinator daemon. Lightweight daemon lifecycle management.

## Parse Arguments

Extract from `$ARGUMENTS`:

```
$ARGUMENTS = [--stop]
```

- **`--stop`:** If present, stop the running daemon and kill the tmux session.
- **No arguments:** Start the daemon (or show status if already running).

---

## Step 1: Check Current Status

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

Also check for the tmux session:

```bash
tmux has-session -t coord-daemon 2>/dev/null && echo "TMUX_EXISTS" || echo "NO_TMUX"
```

---

## Step 2: Handle --stop

If `--stop` was specified:

1. **Send SIGTERM to the daemon:**

```bash
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  kill "$PID" 2>/dev/null || true
  sleep 1
  rm -f "$PID_FILE"
fi
```

2. **Kill the tmux session:**

```bash
tmux kill-session -t coord-daemon 2>/dev/null || true
```

3. **Report:**

```
Coordinator stopped.
  PID $PID terminated.
  tmux session 'coord-daemon' removed.
```

**Done.** Do not proceed to further steps.

---

## Step 3: If Already Running — Show Status

If the daemon is running (Step 1 returned `RUNNING`):

Run `coord status` and display the output:

```bash
COORD_CMD="node $HOME/.claude/coordinator/build/cli/coord.js"
$COORD_CMD status
```

Report:

```
Coordinator is running (PID <pid>).
  tmux session: coord-daemon
  Attach: tmux attach -t coord-daemon
```

**Done.** Do not proceed to further steps.

---

## Step 4: Start the Daemon

### Detect main worktree

```bash
MAIN_WORKTREE=$(git worktree list | head -1 | awk '{print $1}')
```

### Build if needed

```bash
if [ ! -f "$COORD_DIR/build/index.js" ]; then
  echo "Building coordinator..."
  (cd "$COORD_DIR" && npm install && npm run build)
fi
```

### Extract Trello credentials

```bash
MCP_JSON="$HOME/.claude/mcp.json"
TRELLO_API_KEY="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$MCP_JSON','utf8')).mcpServers.trello.env.TRELLO_API_KEY || '')")"
TRELLO_TOKEN="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$MCP_JSON','utf8')).mcpServers.trello.env.TRELLO_TOKEN || '')")"
```

If either is empty, STOP and tell the user to configure Trello credentials in `~/.claude/mcp.json`.

### Clean stale state

```bash
rm -f "$PID_FILE"
tmux kill-session -t coord-daemon 2>/dev/null || true
```

### Launch in tmux

```bash
tmux new-session -d -s coord-daemon -c "$MAIN_WORKTREE" \
  -e "TRELLO_API_KEY=$TRELLO_API_KEY" \
  -e "TRELLO_TOKEN=$TRELLO_TOKEN"

# Start daemon in top pane
tmux send-keys -t coord-daemon \
  "node $COORD_DIR/build/index.js --main-worktree $MAIN_WORKTREE --log-level debug" Enter

# Bottom pane: interactive shell for coord commands
tmux split-window -t coord-daemon -v -p 40 -c "$MAIN_WORKTREE" \
  -e "TRELLO_API_KEY=$TRELLO_API_KEY" \
  -e "TRELLO_TOKEN=$TRELLO_TOKEN"
```

### Wait for startup (up to 5s)

```bash
for i in 1 2 3 4 5; do
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Coordinator started (PID $(cat "$PID_FILE"))"
    break
  fi
  sleep 1
done
```

If still not running after 5s, report the error and suggest checking `tmux attach -t coord-daemon` for logs.

### Open iTerm2 tab

```bash
osascript <<'APPLESCRIPT'
tell application "iTerm2"
    tell current window
        create tab with default profile
        tell current session
            write text "tmux attach -t coord-daemon"
        end tell
    end tell
end tell
APPLESCRIPT
```

Skip silently if iTerm2 is not running.

---

## Step 5: Report

```
Coordinator started.
  PID:      <pid>
  Worktree: <main-worktree>
  tmux:     coord-daemon
  Attach:   tmux attach -t coord-daemon

  Commands:
    node ~/.claude/coordinator/build/cli/coord.js status
    node ~/.claude/coordinator/build/cli/coord.js spawn "<card>"
    node ~/.claude/coordinator/build/cli/coord.js stop
```
