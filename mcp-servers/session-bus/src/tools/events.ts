import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FileEventStore } from "../store.js";
import { errorResult } from "../types.js";

export function registerEventTools(server: McpServer, store: FileEventStore): void {
  server.tool(
    "session_bus_read_events",
    "Read events published by a session. Supports filtering by event type, timestamp, and count. Returns events in chronological order.",
    {
      session_id: z
        .string()
        .describe("Session ID to read events from"),
      event_types: z
        .array(z.string())
        .optional()
        .describe("Filter by event type(s), e.g. ['phase_complete', 'error']"),
      since: z
        .string()
        .optional()
        .describe("Only return events after this ISO 8601 timestamp"),
      last_n: z
        .number()
        .optional()
        .describe("Return only the last N events"),
    },
    async ({ session_id, event_types, since, last_n }) => {
      try {
        const events = await store.readEvents(session_id, {
          eventTypes: event_types,
          since,
          lastN: last_n,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ events, count: events.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
