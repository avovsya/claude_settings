# Plan: Enhanced WIP Dashboard

**Task:** Enhance the "Task Status" / `wip` workflow with richer data gathering
**Branch:** feature/enhanced-wip-dashboard
**Trello:** https://trello.com/c/NdzwdSch/7-2-enhanced-wip-dashboard
**Status:** Final (post-review)

---

## Architecture & Rationale

The current Task Status section (CLAUDE.md lines 275-284) defines a 5-step workflow that gathers basic info (Trello cards, tmux sessions, plan files, backlog). The enhancement adds 5 new data sources to produce a richer dashboard without changing the workflow structure.

**Approach:** Expand the existing section in-place. The Task Status remains a read-only monitoring command. All new data sources are optional with graceful fallback.

**New table format:**
```
| Task | Priority | tmux | Branch | Phase | Build | Last Activity | Health |
```

Dropped: `Worktree` (path is verbose, branch is sufficient), `Plan` (subsumed into Phase detection).

---

## Files to Modify

| # | File | Lines | Change |
|---|------|-------|--------|
| 1 | `CLAUDE.md` | 275-284 | Replace Task Status section with enhanced version |
| 2 | `CHEATSHEET.md` | 113-120, 258-262 | Update Monitoring Workers section and status reference |
| 3 | `CLAUDE_REFERENCE.md` | 15 | Update Task Status entry in Structure Map |

---

## Architect Review — Incorporated Feedback

The Software Architect review raised valid points. Here's how each is addressed:

1. **Phase signal priority:** Signal files (`/tmp/claude-phase-complete-*.json`) take precedence when they exist. Fallback chain is explicit: signal file → plan heuristic → "Discovery".
2. **Stale definition:** Precisely defined as: "Implementing" card + no commits in 2h + no active tmux session. Completed/merged work is never flagged.
3. **Build column semantics:** PASS = last build log shows success; FAIL = last build log shows failure; — = no build logs found.
4. **Health column window:** Compaction count within last 24h, scoped to worktree cwd. — if metrics file doesn't exist.
5. **Token budget:** CLAUDE.md section kept to ~140 words. Detailed data source instructions go in CHEATSHEET.md.
6. **"Idle tmux" ambiguity:** Removed. Stale check uses only "no active tmux session" (session exists or not).
7. **Phase signal format dependency:** Noted as optional; format defined by the separate phase-completion-hook task. Dashboard gracefully skips if files don't exist.
8. **Compaction metrics dependency:** Hook exists (`hooks/pre-compact-metrics.sh`), writes `{ts, cwd, source}` to `~/.claude/compaction-metrics.jsonl`. File is created on first compaction event. Dashboard shows — if file doesn't exist yet.

---

## Exact Content: CLAUDE.md Task Status Section

Replace lines 275-284 with:

```markdown
## Task Status

**Triggers:** "wip", "task status", "what am I working on"

1. **Gather** from all active worktrees:
   - Trello "Implementing" cards, active tmux sessions (`tmux list-sessions`)
   - `Plans/PLAN_*.md` files, P1/P2 from "To Do"
   - Per worktree: last commit time (`git log -1 --format="%ct"`), build logs, phase signals, compaction metrics

2. **Show active tasks table:**

   | Task | Priority | tmux | Branch | Phase | Build | Last Activity | Health |
   |------|----------|------|--------|-------|-------|---------------|--------|

   Column details:
   - **Phase:** From `/tmp/claude-phase-complete-*.json` if exists (parse `phase` field), else heuristic: no PLAN → Discovery, PLAN exists → Planning, commits after plan → Implementation, merged → Completed
   - **Build:** Most recent `build.log` or `build/*.log` in worktree (by mtime). PASS / FAIL / — (no logs)
   - **Last Activity:** Relative time since last commit (`git log -1 --format="%cr"`). Mark **(STALE)** if 2+ hours
   - **Health:** Compaction count from `~/.claude/compaction-metrics.jsonl` (entries matching worktree cwd, last 24h). — if unavailable

3. **Stale tasks:** "Implementing" cards where BOTH: no commits in 2+ hours AND no active tmux session → suggest cleanup or resume

4. **High priority backlog:** P1-Critical + P2-High from "To Do"

5. **Suggest actions:** attach, start working, finish task, recover task
```

---

## Exact Content: CHEATSHEET.md Monitoring Workers Section

Replace lines 113-120 with:

```markdown
### Monitoring Workers

```
"wip"                          -- dashboard of all active tasks
"task status"                  -- same thing
```

Shows enhanced dashboard:
```
| Task | Priority | tmux | Branch | Phase | Build | Last Activity | Health |
|------|----------|------|--------|-------|-------|---------------|--------|
| Feature X | P1 | active | feat/x | Phase 4 | PASS | 15m ago | 1 compaction |
| Bug Y | P2 | — | fix/y | Planning | — | 3h ago (STALE) | 0 compactions |
```

**Data sources:** Trello cards, tmux sessions, git worktrees + commit history, `Plans/PLAN_*.md`, build logs (per worktree), `/tmp/claude-phase-complete-*.json` (phase signals), `~/.claude/compaction-metrics.jsonl` (context health).

**Stale:** No commits in 2+ hours AND no active tmux → flagged for cleanup/resume.
```

---

## Exact Content: CHEATSHEET.md Status Reference (lines 258-262)

Replace lines 258-262 with:

```markdown
### Check status of all active workers

1. In Dispatcher: `"wip"`
2. Review: active tasks table (phase, build, last activity, health), stale tasks, backlog
3. Attach to any worker to check progress: `tmux attach -t <name>`
```

---

## Exact Content: CLAUDE_REFERENCE.md Structure Map Entry

Replace line 15 with:

```markdown
| **Task Status** | Dashboard: active tasks with build status, phase progress, stale detection (2h), context health (compaction count) | Triggered by "wip" or "task status" |
```

---

## Implementation Order

1. CLAUDE.md (primary deliverable — defines the workflow)
2. CHEATSHEET.md (sync the human reference)
3. CLAUDE_REFERENCE.md (sync the structure map entry)

---

## Edge Cases (all handled with graceful fallback)

| Condition | Behavior |
|-----------|----------|
| No compaction metrics file | Health: — |
| No phase signal files | Fall back to plan-based heuristic |
| No build logs in worktree | Build: — |
| Worktree with no commits | Last Activity: "no commits" |
| Multiple compaction events for same cwd | Count all within last 24h |
| Card in "Implementing" but branch merged | Phase: Completed (not flagged stale) |

---

## Testing

- Read the updated CLAUDE.md and verify the workflow instructions are unambiguous
- Verify CHEATSHEET.md example output matches CLAUDE.md table format
- Verify CLAUDE_REFERENCE.md entry is consistent
- Verify no token bloat (CLAUDE.md section should be ~140 words)
