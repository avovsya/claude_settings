import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execTmux, buildTarget, validateFile } from "../tmux.js";
import { errorResult } from "../types.js";

export function registerClaudeTools(server: McpServer): void {
  server.tool(
    "tmux_launch_claude",
    "Launch Claude Code in a tmux pane. Internally handles `unset CLAUDECODE &&` to prevent environment leakage to child sessions. Supports prompt file delivery (most reliable) and --continue/--resume flags.",
    {
      session: z.string().describe("Target session name"),
      pane: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pane index (default: 0)"),
      prompt_file: z
        .string()
        .optional()
        .describe(
          "Path to prompt file (sent via `cat <file> | claude`). Most reliable method for delivering prompts.",
        ),
      continue_session: z
        .boolean()
        .optional()
        .describe("Use --continue flag to resume most recent session in cwd"),
      resume: z
        .string()
        .optional()
        .describe("Session ID for --resume (resumes a specific session)"),
    },
    async ({ session, pane, prompt_file, continue_session, resume }) => {
      try {
        const target = buildTarget(session, pane);

        // Build the claude command
        let claudeCmd = "unset CLAUDECODE && ";

        if (prompt_file) {
          const resolvedFile = validateFile(prompt_file, "Prompt file");
          claudeCmd += `cat ${shellQuote(resolvedFile)} | claude`;
        } else if (continue_session) {
          claudeCmd += "claude --continue";
        } else if (resume) {
          claudeCmd += `claude --resume ${shellQuote(resume)}`;
        } else {
          claudeCmd += "claude";
        }

        // Send the command literally then press Enter
        await execTmux(["send-keys", "-t", target, "-l", claudeCmd]);
        await execTmux(["send-keys", "-t", target, "Enter"]);

        return {
          content: [
            {
              type: "text" as const,
              text: `Claude launched in ${target}.\nCommand: ${claudeCmd}`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "tmux_approve_permission",
    "Approve a permission prompt in a Claude Code session. Captures pane output to verify a permission prompt exists, then sends Enter (or a specific option number) to approve.",
    {
      session: z.string().describe("Target session name"),
      pane: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pane index (default: 0)"),
      option: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe(
          "Option number to select (default: press Enter for first/highlighted option)",
        ),
    },
    async ({ session, pane, option }) => {
      try {
        const target = buildTarget(session, pane);

        // Capture pane to check for permission prompt
        const output = await execTmux([
          "capture-pane",
          "-t",
          target,
          "-p",
          "-S",
          "-30",
        ]);

        const isPermissionPrompt =
          /allow\s+\S/i.test(output) ||
          /\[y\/n\]/i.test(output) ||
          /^\s*\d\)\s/m.test(output);

        if (!isPermissionPrompt) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No permission prompt detected in ${target}. Last output:\n${output.split("\n").slice(-10).join("\n")}`,
              },
            ],
            isError: true,
          };
        }

        if (option !== undefined && option > 0) {
          // Send the option number then Enter
          await execTmux(["send-keys", "-t", target, "-l", String(option)]);
          await execTmux(["send-keys", "-t", target, "Enter"]);
        } else {
          // Just press Enter (selects first/highlighted option)
          await execTmux(["send-keys", "-t", target, "Enter"]);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Permission approved in ${target}${option ? ` (option ${option})` : " (Enter)"}`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "tmux_interrupt",
    "Send Escape and/or Ctrl-C to a tmux pane to interrupt running operations or unstick workers.",
    {
      session: z.string().describe("Target session name"),
      pane: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pane index (default: 0)"),
      signal: z
        .enum(["escape", "ctrl-c", "both"])
        .optional()
        .describe('What to send: "escape", "ctrl-c", or "both" (default: "both")'),
    },
    async ({ session, pane, signal }) => {
      try {
        const target = buildTarget(session, pane);
        const action = signal ?? "both";

        if (action === "escape" || action === "both") {
          await execTmux(["send-keys", "-t", target, "Escape"]);
        }
        if (action === "ctrl-c" || action === "both") {
          await execTmux(["send-keys", "-t", target, "C-c"]);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Interrupt sent to ${target} (${action})`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

/**
 * Simple shell quoting for a single argument.
 * Wraps in single quotes and escapes any internal single quotes.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
