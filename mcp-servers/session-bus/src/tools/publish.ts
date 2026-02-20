import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FileEventStore } from "../store.js";
import { errorResult, VALID_EVENT_TYPES, type EventType } from "../types.js";

export function registerPublishTools(server: McpServer, store: FileEventStore): void {
  server.tool(
    "session_bus_publish",
    "Publish an event to the session bus. Auto-registers the session if not already registered. Use this to signal phase completions, errors, blockers, build results, etc. to other sessions.",
    {
      session_id: z
        .string()
        .describe("The publishing session's ID"),
      event_type: z
        .enum([...VALID_EVENT_TYPES] as [string, ...string[]])
        .describe(
          "Event type: phase_complete, plan_ready, blocked, error, wip_committed, split_requested, build_result, session_started, context_warning",
        ),
      data: z
        .record(z.unknown())
        .describe("Event-specific payload (JSON object)"),
    },
    async ({ session_id, event_type, data }) => {
      try {
        const event = await store.publishEvent(
          session_id,
          event_type as EventType,
          data as Record<string, unknown>,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  published: true,
                  timestamp: event.timestamp,
                  sequence: event.sequence,
                  event_type: event.event_type,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
