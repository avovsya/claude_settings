import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FileEventStore } from "../store.js";
import { errorResult, VALID_SESSION_STATUSES, type SessionStatus } from "../types.js";

export function registerGcTools(server: McpServer, store: FileEventStore): void {
  server.tool(
    "session_bus_garbage_collect",
    "Clean up old sessions and events. By default, deletes terminal sessions (completed/partial/blocked/dead) older than 7 days. Use dry_run=true to preview what would be deleted.",
    {
      max_age_hours: z
        .number()
        .optional()
        .describe("Delete items older than N hours (default: 168 = 7 days)"),
      dry_run: z
        .boolean()
        .optional()
        .describe("If true, report what would be deleted without deleting (default: false)"),
      status: z
        .enum([...VALID_SESSION_STATUSES] as [string, ...string[]])
        .optional()
        .describe("Only clean sessions with this status"),
    },
    async ({ max_age_hours, dry_run, status }) => {
      try {
        const result = await store.garbageCollect({
          maxAgeHours: max_age_hours,
          dryRun: dry_run,
          status: status as SessionStatus | undefined,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "session_bus_health",
    "Check if the session bus is operational. Returns base directory, session count, and writability status.",
    {},
    async () => {
      try {
        const health = await store.health();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(health, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
