# Plan: Phase Completion Hook

**Status:** In Progress
**Branch:** feature/phase-completion-hook
**Trello:** https://trello.com/c/2nHzQpbK/6-1-phase-completion-hook

---

## Architecture Overview

A Claude Code `Stop` hook that detects when a worker outputs a completion/finish report and writes a machine-readable signal file to `/tmp/claude-phase-complete-{session}.json`. This enables automated status detection without manually attaching to tmux sessions.

### Key Design Decisions

1. **`Stop` hook type** — Fires when Claude finishes responding. Receives `last_assistant_message` with full response text and `session_id` via JSON on stdin. No matcher needed (fires on every stop). Does not fire on user interrupts.

2. **Pattern matching on structured output** — Detect completion reports by matching structural markers from the Finish Task workflow: markdown table rows containing "Build", "Plan", "Commit" headers, or explicit COMPLETION_REPORT references. This avoids false positives from casual mentions.

3. **Three status types:**
   - `completed` — Structured report with table markers (Build/Plan/Commit rows) detected
   - `partial` — COMPLETION_REPORT.md reference or "needs continuation" language
   - `blocked` — Explicit "blocked" combined with "cannot proceed" / "waiting for" / "requires"

4. **Best-effort data extraction** — Phase number, commit hash, and artifacts extracted via POSIX-compatible regex with graceful fallback to null/empty.

5. **Atomic file writes** — Use `mktemp` then `mv` to prevent partial reads by external tools.

6. **macOS-first** — All regex uses POSIX character classes (`[0-9]`, `[[:space:]]`) and `grep -E`. No GNU-only features.

7. **Safe JSON construction** — All strings passed to jq via `--arg` to handle special characters, newlines, quotes.

---

## Files to Modify

### 1. `hooks/phase-completion-hook.sh` (NEW — ~90 lines)

Bash script that:
- Reads Stop hook JSON from stdin via `jq`
- Extracts `last_assistant_message`, `session_id`, `cwd`
- Detects completion report patterns via `grep -Eq` (POSIX extended)
- Determines status (completed/partial/blocked) or exits if no match
- Extracts phase number, commit hash from text
- Writes signal file atomically to `/tmp/claude-phase-complete-{session}.json`

**Detection patterns (POSIX grep -E):**

| Status | Pattern | Rationale |
|--------|---------|-----------|
| `completed` | `\| *Build *\|` AND `\| *Commit *\|` (table row markers) | Finish Task report always has Build + Commit rows |
| `partial` | `COMPLETION_REPORT` OR `needs continuation` OR `commit WIP` | Leaf worker context exhaustion signals |
| `blocked` | `blocked` AND (`cannot proceed` OR `waiting for` OR `requires.*approval`) | Worker stuck on external dependency |

**Data extraction (POSIX grep -oE):**

| Field | Regex | Fallback |
|-------|-------|----------|
| `session_id` | From hook input JSON (always present) | — |
| `timestamp` | `date -u +%Y-%m-%dT%H:%M:%SZ` | Always succeeds |
| `status` | Pattern matching (above) | No signal file written |
| `phase_completed` | `[Pp]hase[[:space:]]*[0-9]` → extract digit | `null` |
| `commit` | `[0-9a-f]{7,40}` near "commit" or "hash" keyword | `null` |
| `artifacts` | File paths: `[a-zA-Z0-9._/-]+\.(md\|swift\|json\|sh\|py\|ts\|js)` | `[]` |

### 2. `settings.json` (MODIFY — add `hooks` section)

Add a `Stop` hook entry:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "hooks/phase-completion-hook.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

---

## Signal File Format

**Path:** `/tmp/claude-phase-complete-{session_id}.json`

```json
{
  "session_id": "abc123",
  "timestamp": "2026-02-20T14:30:00Z",
  "status": "completed",
  "phase_completed": 5,
  "artifacts": ["Plans/PLAN_FOO.md", "src/main.swift"],
  "commit": "a1b2c3d",
  "cwd": "/path/to/worktree",
  "summary": "First 200 chars of the completion message..."
}
```

---

## Testing Strategy

1. **Unit test: completed status** — Feed sample Finish Task report (with Build/Commit table rows) through script, verify signal file with `status: "completed"`
2. **Unit test: partial status** — Feed COMPLETION_REPORT.md reference, verify `status: "partial"`
3. **Unit test: blocked status** — Feed "blocked, cannot proceed" message, verify `status: "blocked"`
4. **False positive test** — Messages mentioning "commit" or "build" casually should NOT trigger (requires table format)
5. **Graceful degradation** — Messages without phase numbers or commit hashes produce `null` values
6. **Empty/missing input** — Script exits 0 without error

---

## Edge Cases

- **Multiple stops per session:** Signal file is overwritten (latest wins). Correct — final stop is completion state.
- **Very long messages:** Use `grep -m1` for early exit. Truncate summary to 200 chars.
- **No completion detected:** Script exits 0 without writing signal file. Most stops are NOT completions.
- **Concurrent workers:** Each worker has unique session_id, so signal files don't collide.
- **jq missing:** Script checks `command -v jq` and exits cleanly if unavailable.
- **Disk full:** Write failure caught, exits without blocking Stop event.

---

## Implementation Order

1. Create `hooks/phase-completion-hook.sh` (the detection script)
2. Add `hooks` config to `settings.json`
3. Test with sample inputs
