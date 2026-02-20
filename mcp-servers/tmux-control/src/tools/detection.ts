import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execTmux, buildTarget } from "../tmux.js";
import { errorResult, type PromptDetection } from "../types.js";

/** Detection patterns in priority order (highest specificity first) */
const PATTERNS = {
  plan_mode: {
    test: (lines: string[]) => {
      const text = lines.join("\n");
      return /plan\s+mode/i.test(text) || /read[- ]only/i.test(text);
    },
    confidence: 0.9,
  },
  edit_acceptance: {
    test: (lines: string[]) => {
      const text = lines.join("\n");
      const hasDiff = /^[+-]{3}\s/m.test(text);
      const hasApproval = /(accept|approve|reject|save)/i.test(text);
      return hasDiff && hasApproval;
    },
    confidence: 0.85,
  },
  permission_prompt: {
    test: (lines: string[]) => {
      const text = lines.join("\n");
      return (
        /allow\s+\S/i.test(text) &&
        (/\[y\/n\]/i.test(text) || /^\s*\d\)\s/m.test(text) || /yes.*no/i.test(text))
      );
    },
    confidence: 0.85,
  },
  idle: {
    test: (lines: string[]) => {
      // Find last non-empty line
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed.length > 0) {
          return trimmed === ">" || trimmed === "$" || trimmed.endsWith("$");
        }
      }
      return false;
    },
    confidence: 0.8,
  },
} as const;

export function registerDetectionTools(server: McpServer): void {
  server.tool(
    "tmux_detect_prompt_type",
    "Parse pane output to identify what state a Claude Code session is in. Returns a state (plan_mode, edit_acceptance, permission_prompt, idle, processing, unknown) with a confidence score. Known limitation: a single capture cannot reliably distinguish 'processing' from 'stuck'.",
    {
      session: z.string().describe("Target session name"),
      pane: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pane index (default: 0)"),
    },
    async ({ session, pane }) => {
      try {
        const target = buildTarget(session, pane);

        const output = await execTmux([
          "capture-pane",
          "-t",
          target,
          "-p",
          "-S",
          "-100",
        ]);

        const lines = output.split("\n");
        const lastLines = lines.slice(-30);

        const detection = detectState(lastLines);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(detection, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

function detectState(lines: string[]): PromptDetection {
  for (const [state, pattern] of Object.entries(PATTERNS) as [
    keyof typeof PATTERNS,
    (typeof PATTERNS)[keyof typeof PATTERNS],
  ][]) {
    if (pattern.test(lines)) {
      return {
        state,
        confidence: pattern.confidence,
        last_lines: lines.slice(-10),
      };
    }
  }

  // Default: processing or unknown
  const hasContent = lines.some((l) => l.trim().length > 0);
  return {
    state: hasContent ? "processing" : "unknown",
    confidence: 0.3,
    last_lines: lines.slice(-10),
  };
}
