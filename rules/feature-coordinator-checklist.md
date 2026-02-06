# Feature Coordinator Checklist

This is a persistent reminder for long-running feature sessions. Context compression may discard details from CLAUDE.md — this rule ensures critical steps aren't skipped.

## Mandatory Gates (DO NOT skip)

**Before writing any code:**
- Phase 1 (Deep Research) and Phase 2 (Cross-Cutting Analysis) must be complete
- Phase 3b (Expert Review Panel) must critique the plan before presenting to user
- User must approve the plan before implementation begins

**During implementation (Phase 4):**
- Use background agents for analysis/review; foreground for implementation
- Coordinator must review every sub-agent output before acting on it
- Build after each major change (`./Scripts/build.sh`)
- Get user approval between major phases

**Before committing (Finish Task):**
- Verify build passes
- Update PLAN_*.md with status, date, deviations
- **Documentation Maintenance (mandatory):** Spawn a Review Agent to check if docs need updating — see full procedure in CLAUDE.md under "Finish Task > Documentation Maintenance". Do NOT skip this step.
- Update Trello card (move list, update description)

## Common Mistakes in Long Sessions

- Skipping Phase 3b (Expert Review Panel) to save time — never skip this
- Forgetting to synthesize sub-agent findings before proceeding to next phase
- Implementing before user approves the plan
- Committing without running documentation maintenance review
- Merging without verifying build one final time
- Not updating Trello card at completion
- Running parallel implementation agents on files that overlap — always check for shared files first
