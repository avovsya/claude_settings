import { writeFile } from "node:fs/promises";

const PHASE_NAMES: Record<number, string> = {
  1: "Deep Research",
  2: "Cross-Cutting Analysis",
  3: "Planning",
  4: "Implementation",
  5: "Verification",
};

const PHASE_INSTRUCTIONS: Record<number, string> = {
  1: "Spawn parallel Analysis Agents.",
  2: "Spawn cross-cutting Analysis Agents.",
  3: "Draft the implementation plan in Plans/.",
  4: "Begin implementation following the approved plan.",
  5: "Spawn parallel Review Agents for verification.",
};

export interface PromptParams {
  /** Coordinator-assigned session ID for session-bus registration */
  sessionId: string;
  /** Card name / task title */
  cardName: string;
  /** Git branch name */
  branch: string;
  /** Trello card URL (if any) */
  trelloUrl?: string;
  /** Card description / requirements */
  cardDescription: string;
  /** Card labels */
  labels: string[];
  /** Worker config */
  remainingSplits: number;
  startPhase: number;
  /** Path where approval decisions will be written */
  decisionsDir: string;
}

/**
 * Generate a worker prompt file.
 * Ports the logic from spawn-worker SKILL.md.
 */
export async function generatePrompt(
  outputPath: string,
  params: PromptParams,
): Promise<void> {
  const phaseName = PHASE_NAMES[params.startPhase] ?? "Unknown";
  const phaseInstruction = PHASE_INSTRUCTIONS[params.startPhase] ?? "Begin work.";
  const labelsStr = params.labels.length > 0 ? params.labels.join(", ") : "None";

  const prompt = `## Task: ${params.cardName}

**Branch:** ${params.branch}
${params.trelloUrl ? `**Trello:** ${params.trelloUrl}` : ""}
**Card Description:**
${params.cardDescription.slice(0, 500)}

**Labels:** ${labelsStr}

### Requirements

${params.cardDescription}

---

## Worker Configuration

session_id: ${params.sessionId}
remaining_splits: ${params.remainingSplits}
start_phase: ${params.startPhase}

You are operating under the Recursive Worker Model:
- Phase 1: Deep Research (mandatory before any code)
- Phase 2: Cross-Cutting Analysis -> then run Context Capacity Check
- Phase 3a: Draft Implementation Plan, 3b: Expert Review Panel (mandatory before user sees plan)
- Phase 4: Implementation (sequential, coordinator reviews each agent output)
- Phase 5: Verification (parallel review agents)

Follow the **Recursive Worker Model** defined in your global CLAUDE.md.
At Phase 2 completion, run the Context Capacity Check.
If this task requires splitting, follow the Self-Replication Protocol.

## Session Bus Integration

Your session ID is: **${params.sessionId}**

When you start, register yourself with the session bus:
- Call session_bus_register_session with session_id="${params.sessionId}"

Publish events to the session bus at key milestones:
- phase_complete: when you finish a phase
- plan_ready: when your plan is ready for review (Phase 3b)
- blocked: if you encounter a blocker
- build_result: after build attempts
- wip_committed: if you commit a WIP checkpoint

The coordinator monitors your session bus events and will respond to plan_ready
events with approval decisions.

## Permission Model

You are running with \`--dangerously-skip-permissions\` — all permission checks are bypassed.
This is safe because you are in an isolated worktree on a feature branch.
Exercise normal judgment — avoid destructive commands, don't modify files outside your worktree.

---

**START NOW: Phase ${params.startPhase} (${phaseName}). ${phaseInstruction}**
`;

  await writeFile(outputPath, prompt, "utf8");
}
