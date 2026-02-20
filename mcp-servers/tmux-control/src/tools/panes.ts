import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execTmux, buildTarget, validatePath } from "../tmux.js";
import { errorResult, CAPTURE_DEFAULT_LINES, CAPTURE_MAX_LINES } from "../types.js";

export function registerPaneTools(server: McpServer): void {
  server.tool(
    "tmux_split_window",
    "Split a tmux window into a new pane. Default: vertical split with 30% for the new pane.",
    {
      session: z.string().describe("Target session name"),
      direction: z
        .enum(["horizontal", "vertical"])
        .optional()
        .describe("Split direction (default: vertical)"),
      percent: z
        .number()
        .min(1)
        .max(99)
        .optional()
        .describe("Size of new pane as percentage (default: 30)"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory for the new pane"),
    },
    async ({ session, direction, percent, cwd }) => {
      try {
        const args = ["split-window", "-t", session];

        // -v = vertical split (top/bottom), -h = horizontal (left/right)
        if (direction === "horizontal") {
          args.push("-h");
        } else {
          args.push("-v");
        }

        if (percent !== undefined) {
          args.push("-p", String(percent));
        } else {
          args.push("-p", "30");
        }

        if (cwd) {
          const resolvedCwd = validatePath(cwd, "Working directory");
          args.push("-c", resolvedCwd);
        }

        await execTmux(args);

        // Get pane info
        const info = await execTmux([
          "list-panes",
          "-t",
          session,
          "-F",
          "#{pane_index}\t#{pane_width}x#{pane_height}\t#{pane_current_path}",
        ]);

        return {
          content: [
            {
              type: "text" as const,
              text: `Window split successfully.\nPanes:\n${info.trim()}`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "tmux_send_keys",
    'Send keystrokes to a tmux pane. By default sends text literally (no tmux key interpretation) and presses Enter. NOTE: Sending Enter to Claude Code\'s text input field is unreliable via tmux — text is added but NOT submitted. Use tmux_launch_claude with prompt_file for reliable command execution.',
    {
      session: z.string().describe("Target session name"),
      pane: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pane index (default: 0)"),
      text: z.string().describe("Text to send to the pane"),
      enter: z
        .boolean()
        .optional()
        .describe("Press Enter after text (default: true)"),
      literal: z
        .boolean()
        .optional()
        .describe(
          "Send text literally with -l flag, preventing tmux key name interpretation (default: true)",
        ),
    },
    async ({ session, pane, text, enter, literal }) => {
      try {
        const target = buildTarget(session, pane);
        const shouldLiteral = literal !== false;
        const shouldEnter = enter !== false;

        const args = ["send-keys", "-t", target];
        if (shouldLiteral) {
          args.push("-l");
        }
        args.push(text);

        await execTmux(args);

        if (shouldEnter) {
          await execTmux(["send-keys", "-t", target, "Enter"]);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Keys sent to ${target}${shouldEnter ? " (with Enter)" : ""}.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "tmux_capture_pane",
    "Read recent output from a tmux pane. Returns the last N lines of pane history.",
    {
      session: z.string().describe("Target session name"),
      pane: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pane index (default: 0)"),
      lines: z
        .number()
        .int()
        .min(1)
        .max(CAPTURE_MAX_LINES)
        .optional()
        .describe(
          `Number of history lines to capture (default: ${CAPTURE_DEFAULT_LINES}, max: ${CAPTURE_MAX_LINES})`,
        ),
    },
    async ({ session, pane, lines }) => {
      try {
        const target = buildTarget(session, pane);
        const numLines = lines ?? CAPTURE_DEFAULT_LINES;

        const output = await execTmux([
          "capture-pane",
          "-t",
          target,
          "-p",
          "-S",
          `-${numLines}`,
        ]);

        return {
          content: [
            {
              type: "text" as const,
              text: output,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
