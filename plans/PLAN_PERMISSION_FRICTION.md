# Plan: Permission Friction Fix for Autonomous Workers

**Status:** COMPLETED (2026-02-20)
**Card:** https://trello.com/c/HtnXWnQK/17-permission-friction-fix-for-autonomous-workers
**Branch:** fix/permission-friction

## Problem

Workers spawned via `/spawn-worker` encounter ~15 manual permission approvals per 16-minute run:
- **File edit prompts** (Edit/Write tools) — every file modification prompts for approval
- **Bash command prompts** — any command not in the settings.json allow list
- **No permission flags** — workers launch with bare `claude` command, no permission configuration

## Architecture

### Key Insight: Global vs Per-Worker Permissions

| Mechanism | Scope | Persists | Use For |
|-----------|-------|----------|---------|
| `~/.claude/settings.json` allow/deny | All sessions | Yes | Safe bash commands (build tools) |
| `--dangerously-skip-permissions` | One session | No | Workers in isolated worktrees |
| `--permission-mode acceptEdits` | One session | No | Alternative (less aggressive) |
| `--allowedTools "Edit" "Write"` | One session | No | Targeted tool pre-approval |

### Decision: Use `--dangerously-skip-permissions` for Workers

Rationale:
1. **Zero prompts** — the only flag that achieves true zero permission friction
2. **Per-session** — does NOT affect the dispatcher or other sessions
3. **Isolated environment** — workers run in dedicated worktrees on feature branches
4. **Low blast radius** — workers can't affect main branch without explicit merge
5. **Model safety** — Claude has built-in safety constraints regardless of permission settings
6. **`acceptEdits` insufficient** — only covers file edits, not bash commands that slip through allow list gaps

### Risk Model

`--dangerously-skip-permissions` removes the permission-check safety layer entirely, including deny rules.

**What worktree isolation DOES protect:**
- Main branch — workers can't modify it without dispatcher merge
- Git history on main — workers can only affect their feature branch
- Other worktrees' branches — each worktree is on its own branch

**What worktree isolation does NOT protect:**
- Filesystem outside the worktree (workers can read/write anywhere the user can)
- Sibling projects or home directory files
- Network access (workers can curl, wget, etc.)

**Why the risk is acceptable:**
- Workers are short-lived (hours, not days)
- Claude has built-in safety constraints (won't rm -rf / unprompted)
- Dispatcher reviews all code before merging to main
- Workers don't push to remote (dispatcher handles merges)
- The friction cost (15 prompts/session) makes parallel workers unusable without bypass

### Rollback

To disable bypass for a specific worker, remove `--dangerously-skip-permissions` from the launch command in SKILL.md Step 9. The worker will revert to standard permission prompts.

## Changes

### 1. Update settings.json allow list (global, safe additions)

Add missing build tools that workers commonly need. These also benefit the dispatcher (fewer prompts for safe operations):
- `Bash(tsc *)` — TypeScript compiler
- `Bash(bun *)` — Bun runtime
- `Bash(swift *)` — Swift compiler/tools
- `Bash(swiftc *)` — Swift compiler
- `Bash(cargo *)` — Rust build tool
- `Bash(rustc *)` — Rust compiler
- `Bash(go *)` — Go tools
- `Bash(docker *)` — Container operations
- `Bash(yarn *)` — Yarn package manager
- `Bash(pnpm *)` — pnpm package manager
- `Bash(deno *)` — Deno runtime

Note: Workers run with `--dangerously-skip-permissions` so these entries mainly benefit dispatcher sessions. They're safe standard build tools.

### 2. Update spawn-worker SKILL.md

**Step 9 launch command** — change from:
```bash
tmux send-keys -t "$SESSION_NAME":.1 "unset CLAUDECODE && cat /tmp/<session-name>-prompt.md | claude" Enter
```
To:
```bash
tmux send-keys -t "$SESSION_NAME":.1 "unset CLAUDECODE && cat /tmp/<session-name>-prompt.md | claude --dangerously-skip-permissions" Enter
```

**Add Permission Model section** to SKILL.md explaining the flag, its safety rationale, and how to disable it.

**Update coordinator child-spawning guidance** — when coordinators manually spawn child workers (outside `/spawn-worker`), they must also include `--dangerously-skip-permissions` in the launch command. Add this to the Self-Replication Protocol section in CLAUDE.md.

### 3. Update worker prompt template

Add a security notice section to the Worker Prompt Template so workers know they have bypass permissions:

```markdown
## Permission Model

You are running with `--dangerously-skip-permissions` (all permission checks bypassed).
This is safe because you are in an isolated worktree on a feature branch.
Exercise normal judgment — avoid destructive commands, don't modify files outside your worktree.
```

### 4. Update CLAUDE.md — Worker Permissions section

Add documentation covering:
- What bypass mode means for workers
- Dispatcher retains standard prompts
- Dispatcher responsibility: review git diffs before merging
- How to disable bypass (remove flag from SKILL.md)
- Update Self-Replication Protocol to include the flag when coordinators spawn children

### 5. Update CLAUDE.md — Self-Replication Protocol

Step 7 (SPAWN children) currently says:
```bash
unset CLAUDECODE && cat /tmp/phase-N-prompt.md | claude
```

Update to:
```bash
unset CLAUDECODE && cat /tmp/phase-N-prompt.md | claude --dangerously-skip-permissions
```

This ensures coordinator-spawned children also get bypass permissions.

## Files Changed

| File | Change |
|------|--------|
| `~/.claude/settings.json` | Add build tools to allow list |
| `~/.claude/skills/spawn-worker/SKILL.md` | Add `--dangerously-skip-permissions` flag + permission model docs |
| `CLAUDE.md` | Add Worker Permissions section + update Self-Replication Protocol |

## Testing

Litmus test: After changes, a spawned leaf worker should run Phases 1-5 with zero permission prompts for:
- File reads (already free — no change needed)
- File edits (bypassed by `--dangerously-skip-permissions`)
- Bash builds (bypassed by flag + extended allow list)
- Git commits (bypassed by flag)
- MCP operations (bypassed by flag)

Cannot fully test without spawning a worker, but can verify:
1. Settings.json is valid JSON after edits
2. SKILL.md launch command includes the flag
3. Documentation is clear and accurate
4. Self-Replication Protocol includes the flag

## Edge Cases

- **Coordinator workers** (remaining_splits > 0): Also get bypass mode via spawn-worker. When they spawn children manually, they must include the flag (documented in Self-Replication Protocol).
- **`--dangerously-skip-permissions` with piped input**: Works — flag is on the `claude` command, not affected by stdin pipe.
- **Future Claude Code updates**: If the flag name or behavior changes, update SKILL.md Step 9 and Self-Replication Protocol. Verify via `claude --help`.
