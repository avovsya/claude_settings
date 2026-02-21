#!/usr/bin/env bash
set -euo pipefail

# coord-start — Start coordinator daemon for a project in a tmux session.
#
# Usage:
#   coord-start [project-dir]
#
# Picks up:
#   - Project dir from $1 or cwd
#   - Trello board from <project>/.trello-board or TRELLO_BOARD_ID env
#   - Trello creds from ~/.claude/mcp.json
#
# Creates a tmux session with:
#   Top pane:    coordinator daemon (foreground, debug logs)
#   Bottom pane: interactive shell with coord on PATH + cheatsheet

COORD_DIR="$HOME/.claude/coordinator"
MCP_JSON="$HOME/.claude/mcp.json"

# --- Resolve project directory ---

PROJECT_DIR="${1:-$(pwd)}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"  # resolve to absolute

if [ ! -d "$PROJECT_DIR/.git" ]; then
  echo "Error: $PROJECT_DIR is not a git repository"
  exit 1
fi

PROJECT_NAME="$(basename "$PROJECT_DIR")"
SESSION_NAME="coord-${PROJECT_NAME,,}"  # lowercase

# --- Check coordinator is built ---

if [ ! -f "$COORD_DIR/build/index.js" ]; then
  echo "Coordinator not built. Building..."
  (cd "$COORD_DIR" && npm install && npm run build)
fi

# --- Extract Trello credentials from mcp.json ---

if [ ! -f "$MCP_JSON" ]; then
  echo "Error: $MCP_JSON not found. Run: cp ~/.claude/mcp.json.template ~/.claude/mcp.json"
  exit 1
fi

TRELLO_API_KEY="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$MCP_JSON','utf8')).mcpServers.trello.env.TRELLO_API_KEY || '')")"
TRELLO_TOKEN="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$MCP_JSON','utf8')).mcpServers.trello.env.TRELLO_TOKEN || '')")"

if [ -z "$TRELLO_API_KEY" ] || [ -z "$TRELLO_TOKEN" ]; then
  echo "Error: Trello credentials not found in $MCP_JSON"
  echo "Set mcpServers.trello.env.TRELLO_API_KEY and TRELLO_TOKEN"
  exit 1
fi

export TRELLO_API_KEY TRELLO_TOKEN

# --- Resolve Trello board ---

BOARD_ID="${TRELLO_BOARD_ID:-}"

# Check for .trello-board file in project root
if [ -z "$BOARD_ID" ] && [ -f "$PROJECT_DIR/.trello-board" ]; then
  BOARD_ID="$(head -1 "$PROJECT_DIR/.trello-board" | tr -d '[:space:]')"
fi

BOARD_INFO=""
if [ -n "$BOARD_ID" ]; then
  BOARD_INFO="$(node -e "
    fetch('https://api.trello.com/1/boards/$BOARD_ID?fields=name,url&key=$TRELLO_API_KEY&token=$TRELLO_TOKEN')
      .then(r => r.json())
      .then(b => process.stdout.write(b.name + ' | ' + b.url))
      .catch(() => process.stdout.write('(could not fetch board name)'))
  " 2>/dev/null || echo "(fetch failed)")"
fi

# --- Check for existing session ---

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "Session '$SESSION_NAME' already exists."
  echo "  Attach:  tmux attach -t $SESSION_NAME"
  echo "  Kill:    tmux kill-session -t $SESSION_NAME"
  read -rp "Kill and recreate? [y/N] " yn
  case "$yn" in
    [yY]*) tmux kill-session -t "$SESSION_NAME" ;;
    *)     echo "Attaching to existing session..."; exec tmux attach -t "$SESSION_NAME" ;;
  esac
fi

# --- Check for stale coordinator PID ---

PID_FILE="$COORD_DIR/coordinator.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE")"
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Coordinator already running (PID $OLD_PID)."
    read -rp "Stop it and start fresh? [y/N] " yn
    case "$yn" in
      [yY]*) kill "$OLD_PID"; sleep 1 ;;
      *)     echo "Aborted."; exit 1 ;;
    esac
  else
    rm -f "$PID_FILE"
  fi
fi

# --- Build cheatsheet for bottom pane ---

CHEATSHEET="$(cat <<HELP
╔══════════════════════════════════════════════════════════════╗
║  Coordinator — $PROJECT_NAME
║  Board: ${BOARD_INFO:-"(no board configured — see below)"}
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  coord status                   Dashboard (workers, queue)   ║
║  coord spawn "<card name>"      Spawn worker for a card      ║
║  coord list                     Pending approvals            ║
║  coord approve [session-id]     Approve plan / merge         ║
║  coord reject <id> "reason"     Reject with feedback         ║
║  coord logs <session-id>        Session-bus event log         ║
║  coord stop                     Stop daemon                  ║
║                                                              ║
║  tmux ls                        List tmux sessions           ║
║  tmux attach -t <session>       Attach to worker             ║
║  Ctrl-b ↑/↓  Switch panes   |  Ctrl-b d  Detach             ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  Board config: echo "<board-id>" > $PROJECT_DIR/.trello-board
║  Find board ID: visit board in browser, ID is in the URL     ║
║  Or set: export TRELLO_BOARD_ID=<id>                         ║
╚══════════════════════════════════════════════════════════════╝
HELP
)"

# --- Create tmux session ---

# Top pane: coordinator daemon
tmux new-session -d -s "$SESSION_NAME" -c "$PROJECT_DIR" \
  -e "TRELLO_API_KEY=$TRELLO_API_KEY" \
  -e "TRELLO_TOKEN=$TRELLO_TOKEN"

# Start daemon in top pane
DAEMON_CMD="node $COORD_DIR/build/index.js --main-worktree $PROJECT_DIR --log-level debug"
tmux send-keys -t "$SESSION_NAME" "$DAEMON_CMD" Enter

# Bottom pane: interactive shell with cheatsheet
tmux split-window -t "$SESSION_NAME" -v -p 40 -c "$PROJECT_DIR" \
  -e "TRELLO_API_KEY=$TRELLO_API_KEY" \
  -e "TRELLO_TOKEN=$TRELLO_TOKEN"

# Print cheatsheet and run initial status
tmux send-keys -t "$SESSION_NAME":.2 "cat <<'EOF'
$CHEATSHEET
EOF
" Enter

# Give daemon a moment to start, then show status
tmux send-keys -t "$SESSION_NAME":.2 "sleep 2 && coord status" Enter

# --- Attach (or open iTerm2 tab) ---

if [ -t 0 ]; then
  # Interactive terminal — attach directly
  exec tmux attach -t "$SESSION_NAME"
else
  # Non-interactive — try iTerm2
  osascript <<APPLESCRIPT 2>/dev/null || true
tell application "iTerm2"
    tell current window
        create tab with default profile
        tell current session
            write text "tmux attach -t $SESSION_NAME"
        end tell
    end tell
end tell
APPLESCRIPT

  echo "Coordinator started in tmux session: $SESSION_NAME"
  echo "  Attach: tmux attach -t $SESSION_NAME"
fi
