# Plan: Structured Completion Format

**Status:** Complete (2026-02-20)
**Branch:** feature/structured-completion-format
**Trello:** https://trello.com/c/i1cGOCYp/8-3-structured-completion-format

## Architecture & Rationale

Add YAML front matter to worker completion reports (`COMPLETION_REPORT.md`) so coordinators and automation can parse worker status without reading prose. The human-readable report follows the YAML block for backward compatibility.

Three scenarios produce completion reports:
1. **Finish Task** (full completion) → `status: completed`
2. **Leaf worker context exhaustion** → `status: partial`
3. **Blocked worker** → `status: blocked`

**Note:** Coordinators do NOT write COMPLETION_REPORT.md — each child worker writes its own. Coordinators write phase prompts instead (see Self-Replication Protocol).

The format spec lives in the "Finish Task" section of CLAUDE.md (primary definition), with references from the "Recursive Worker Model" context exhaustion rules and the feature-coordinator-checklist.

## YAML Front Matter Spec

```yaml
---
status: completed | partial | blocked
branch: <branch-name>
commit: <commit-hash>
completed_at: "YYYY-MM-DD"
phase_completed: 1-5
plan_doc: Plans/PLAN_<NAME>.md
artifacts:
  - path/to/file1
  - path/to/file2
blockers:
  - "description of unresolved issue"
next_steps:
  - "suggested follow-up action"
---
```

### Field Definitions

| Field | Required | Description |
|-------|----------|-------------|
| `status` | Yes | `completed`, `partial`, or `blocked` |
| `branch` | Yes | Git branch name |
| `commit` | Yes | Hash of the final commit in this session. Empty string `""` if no commit made. |
| `completed_at` | Yes | ISO 8601 date (e.g., `"2026-02-20"`) |
| `phase_completed` | Yes | Highest phase fully completed (1-5) |
| `plan_doc` | If Phase 3+ | Path to plan document. Omit if task only reached Phase 1-2. |
| `artifacts` | Yes | List of created/modified file paths. Quote paths containing special characters. |
| `blockers` | Yes | List of unresolved issues (empty list `[]` if none) |
| `next_steps` | Yes | List of suggested follow-up actions (empty list `[]` if none) |

## Files to Change

| # | File | Change |
|---|------|--------|
| 1 | `CLAUDE.md` | Replace Finish Task Step 7 with structured format spec |
| 2 | `CLAUDE.md` | Update Context exhaustion leaf worker line to reference structured format |
| 3 | `CLAUDE.md` | Update Feature Workflow "Completion" line to reference structured report |
| 4 | `rules/feature-coordinator-checklist.md` | Add format requirement to "Before committing" gate |
| 5 | `rules/feature-coordinator-checklist.md` | Update leaf worker section to reference structured format |
| 6 | `rules/feature-coordinator-checklist.md` | Add common mistake about missing YAML front matter |

## Detailed Changes

### Change 1: CLAUDE.md — Finish Task Step 7 (line 271)

**Replace** the single-line `**Step 7:** Report: build status, ...` with:

```markdown
**Step 7:** Write `COMPLETION_REPORT.md` in the worktree root with YAML front matter followed by a human-readable report:

\```yaml
---
status: completed
branch: <branch-name>
commit: <commit-hash>
completed_at: "YYYY-MM-DD"
phase_completed: 5
plan_doc: Plans/PLAN_<NAME>.md
artifacts:
  - path/to/changed/file1
  - path/to/changed/file2
blockers: []
next_steps: []
---
\```

Followed by the human-readable summary:

\```
## Completion Report

| Item | Detail |
|------|--------|
| Build | Passed/Failed |
| Plan | Plans/PLAN_<NAME>.md — COMPLETED |
| Commit | <hash> on <branch> |
| Trello | <list-name> |
| Merge | Merged to main / Not merged |
| Files changed | N files, +X / -Y lines |
| Docs updated | <list of updated docs> |
\```

The YAML front matter enables machine-parseable status for coordinators and automation. For partial completions (leaf worker context exhaustion) use `status: partial`; for blocked tasks use `status: blocked`. See field definitions in Plans/PLAN_STRUCTURED_COMPLETION_FORMAT.md.
```

### Change 2: CLAUDE.md — Context exhaustion (line 204)

**Replace:**
```
- **Implementer (remaining_splits == 0, LEAF):** Finish current unit, commit WIP, write `COMPLETION_REPORT.md` ("Partial -- needs continuation"), STOP
```
**With:**
```
- **Implementer (remaining_splits == 0, LEAF):** Finish current unit, commit WIP, write `COMPLETION_REPORT.md` with structured YAML front matter and `status: partial` (see Finish Task Step 7), STOP
```

### Change 3: CLAUDE.md — Feature Workflow Completion (line 180)

**Replace:**
```
**Completion** -> Run Finish Task workflow.
```
**With:**
```
**Completion** -> Run Finish Task workflow (writes structured `COMPLETION_REPORT.md`).
```

### Change 4: rules/feature-coordinator-checklist.md — Before committing

**Add** after line 29 ("Update Trello card"):
```
- Write `COMPLETION_REPORT.md` with structured YAML front matter (status, branch, commit, artifacts, blockers, next_steps)
```

### Change 5: rules/feature-coordinator-checklist.md — Leaf workers

**Replace** line 22:
```
- If context exhausted: commit WIP, write COMPLETION_REPORT.md, STOP
```
**With:**
```
- If context exhausted: commit WIP, write COMPLETION_REPORT.md with `status: partial` (structured YAML front matter), STOP
```

### Change 6: rules/feature-coordinator-checklist.md — Common Mistakes

**Add** after line 41:
```
- Writing COMPLETION_REPORT.md without YAML front matter -- always use the structured format (see Finish Task Step 7 in CLAUDE.md)
```

## Testing

- Verify YAML in the spec is valid (parseable)
- Verify all cross-references between CLAUDE.md and checklist are consistent
- Verify the format covers all three completion scenarios (completed, partial, blocked)

## Edge Cases

- Worker that makes no commits (blocked before implementation): `commit: ""`, `artifacts: []`
- Coordinator splitting: does NOT write COMPLETION_REPORT.md (coordinators write phase prompts instead)
- `--continue` sessions: final COMPLETION_REPORT.md overwrites any previous checkpoint
- Phase 1-2 only tasks: `plan_doc` field is omitted (no plan was created)
