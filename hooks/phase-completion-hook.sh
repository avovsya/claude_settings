#!/bin/bash
# Phase Completion Hook — detects worker completion/finish reports
#
# Hook type: Stop (fires when Claude finishes responding)
# Input (JSON on stdin):
#   { "session_id": "...", "last_assistant_message": "...", "cwd": "...", ... }
# Output: writes /tmp/claude-phase-complete-{session}.json when completion detected
#
# Detection patterns (priority order):
#   1. YAML front matter — status: completed|partial|blocked (structured format)
#   2. completed — Finish Task report with Build + Commit table rows
#   3. partial   — COMPLETION_REPORT.md reference or "needs continuation"
#   4. blocked   — "blocked" + "cannot proceed" / "waiting for"

set -euo pipefail

# Require jq
command -v jq >/dev/null 2>&1 || exit 0

# Read hook input from stdin
input=$(cat)
[ -z "$input" ] && exit 0

# Extract fields from Stop hook JSON
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')
last_msg=$(printf '%s' "$input" | jq -r '.last_assistant_message // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')

# Nothing to analyze if no message or session
[ -z "$session_id" ] || [ -z "$last_msg" ] && exit 0

# --- Status Detection ---
# Priority: YAML front matter > table markers > keyword heuristics

status=""

# Check for structured YAML front matter (status: completed|partial|blocked)
yaml_status=$(printf '%s' "$last_msg" | grep -oE 'status:[[:space:]]*(completed|partial|blocked)' | head -1 | grep -oE '(completed|partial|blocked)' || true)
if [ -n "$yaml_status" ]; then
  status="$yaml_status"

# Completed: Finish Task report with structured table (Build + Commit rows)
elif printf '%s' "$last_msg" | grep -Eq '\|[[:space:]]*Build[[:space:]]*\|' &&
     printf '%s' "$last_msg" | grep -Eq '\|[[:space:]]*Commit[[:space:]]*\|'; then
  status="completed"

# Partial: leaf worker context exhaustion
elif printf '%s' "$last_msg" | grep -Eiq 'COMPLETION_REPORT|needs continuation|commit WIP'; then
  status="partial"

# Blocked: worker stuck on dependency
elif printf '%s' "$last_msg" | grep -Eiq 'blocked' &&
     printf '%s' "$last_msg" | grep -Eiq 'cannot proceed|waiting for|requires.*approval'; then
  status="blocked"
fi

# No completion pattern detected — exit silently
[ -z "$status" ] && exit 0

# --- Data Extraction (best-effort) ---

# Phase number: look for "Phase N" or "phase_completed: N" patterns, take last occurrence
phase_num=$(printf '%s' "$last_msg" | grep -oE '([Pp]hase[_[:space:]]*([Cc]ompleted)?[[:space:]:]*[0-9])' | tail -1 | grep -oE '[0-9]' || true)
if [ -n "$phase_num" ]; then
  phase_json="$phase_num"
else
  phase_json="null"
fi

# Commit hash: 7-40 hex chars on a line mentioning "commit" or "hash"
commit_hash=$(printf '%s' "$last_msg" | grep -iE 'commit|hash' | grep -oE '[0-9a-f]{7,40}' | head -1 || true)
if [ -n "$commit_hash" ]; then
  commit_json="\"$commit_hash\""
else
  commit_json="null"
fi

# Artifacts: file paths with common extensions (deduplicated, max 50)
artifacts_json=$(printf '%s' "$last_msg" \
  | { grep -oE '[a-zA-Z0-9_./-]+\.(md|swift|h|m|cpp|py|ts|js|json|sh|yaml|yml)' || true; } \
  | sort -u \
  | head -50 \
  | jq -R . \
  | jq -s '.')

# Summary: first 200 chars of the message
summary=$(printf '%s' "$last_msg" | head -c 200)

# --- Write Signal File (atomic) ---

signal_file="/tmp/claude-phase-complete-${session_id}.json"
tmpfile=$(mktemp "/tmp/claude-phase-complete-${session_id}.XXXXXX") || exit 0

jq -n \
  --arg session_id "$session_id" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg status "$status" \
  --argjson phase_completed "$phase_json" \
  --argjson artifacts "$artifacts_json" \
  --argjson commit "$commit_json" \
  --arg cwd "$cwd" \
  --arg summary "$summary" \
  '{
    session_id: $session_id,
    timestamp: $timestamp,
    status: $status,
    phase_completed: $phase_completed,
    artifacts: $artifacts,
    commit: $commit,
    cwd: $cwd,
    summary: $summary
  }' > "$tmpfile" 2>/dev/null || { rm -f "$tmpfile"; exit 0; }

mv "$tmpfile" "$signal_file" 2>/dev/null || { rm -f "$tmpfile"; exit 0; }

exit 0
