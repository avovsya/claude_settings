import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execTmux, validateSessionName, validatePath } from "../tmux.js";
import { TmuxError, errorResult, type TmuxSession } from "../types.js";

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "tmux_create_session",
    "Create a new tmux session with an optional working directory. Session names must be lowercase alphanumeric with hyphens (max 64 chars).",
    {
      name: z
        .string()
        .describe("Session name (lowercase alphanumeric + hyphens, e.g. 'my-worker')"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory for the session (must exist)"),
    },
    async ({ name, cwd }) => {
      try {
        validateSessionName(name);

        const args = ["new-session", "-d", "-s", name];
        if (cwd) {
          const resolvedCwd = validatePath(cwd, "Working directory");
          args.push("-c", resolvedCwd);
        }

        await execTmux(args);

        // Get session info
        const info = await execTmux([
          "list-sessions",
          "-F",
          "#{session_name}:#{session_windows}:#{session_created_string}",
          "-f",
          `#{==:#{session_name},${name}}`,
        ]);

        return {
          content: [
            {
              type: "text" as const,
              text: `Session "${name}" created successfully.\n${info.trim()}`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "tmux_kill_session",
    "Destroy a tmux session and all its windows/panes.",
    {
      session: z.string().describe("Session name to destroy"),
    },
    async ({ session }) => {
      try {
        await execTmux(["kill-session", "-t", session]);
        return {
          content: [
            {
              type: "text" as const,
              text: `Session "${session}" killed successfully.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "tmux_list_sessions",
    "List all active tmux sessions with metadata (name, windows, created time, attached status, size).",
    {},
    async () => {
      try {
        const output = await execTmux([
          "list-sessions",
          "-F",
          "#{session_name}\t#{session_windows}\t#{session_created_string}\t#{session_attached}\t#{session_width}x#{session_height}",
        ]);

        const sessions: TmuxSession[] = output
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const [name, windows, created, attached, size] = line.split("\t");
            return {
              name,
              windows: parseInt(windows, 10),
              created,
              attached: attached === "1",
              size,
            };
          });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(sessions, null, 2),
            },
          ],
        };
      } catch (err) {
        // Server not running = no sessions
        if (err instanceof TmuxError && err.code === "SERVER_NOT_RUNNING") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify([], null, 2),
              },
            ],
          };
        }
        return errorResult(err);
      }
    },
  );
}
