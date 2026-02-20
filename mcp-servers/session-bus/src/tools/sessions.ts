import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FileEventStore } from "../store.js";
import { errorResult, VALID_SESSION_STATUSES, type SessionStatus } from "../types.js";

export function registerSessionTools(server: McpServer, store: FileEventStore): void {
  server.tool(
    "session_bus_register_session",
    "Register a new session with the bus. Creates session directory and metadata. If already registered, merges new fields without overwriting existing values. Publishes an implicit session_started event.",
    {
      session_id: z
        .string()
        .describe("Unique session identifier"),
      branch: z
        .string()
        .optional()
        .describe("Git branch name for this session"),
      worktree: z
        .string()
        .optional()
        .describe("Absolute path to the git worktree"),
      parent_session_id: z
        .string()
        .optional()
        .describe("Parent coordinator session ID (for hierarchy tracking)"),
    },
    async ({ session_id, branch, worktree, parent_session_id }) => {
      try {
        const meta = await store.registerSession(session_id, {
          branch,
          worktree,
          parent_session_id,
        });

        // Publish implicit session_started event
        await store.publishEvent(session_id, "session_started", {});

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { registered: true, metadata: meta },
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

  server.tool(
    "session_bus_get_session",
    "Get metadata for a specific session, including its status, branch, worktree, and completion info.",
    {
      session_id: z
        .string()
        .describe("Session ID to look up"),
    },
    async ({ session_id }) => {
      try {
        const meta = await store.getSession(session_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(meta, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "session_bus_update_session",
    "Update session status or metadata. Setting a terminal status (completed, partial, blocked, dead) also sets completed_at.",
    {
      session_id: z
        .string()
        .describe("Session ID to update"),
      status: z
        .enum([...VALID_SESSION_STATUSES] as [string, ...string[]])
        .optional()
        .describe("New session status"),
      commit: z
        .string()
        .optional()
        .describe("Commit hash (for terminal states)"),
      branch: z
        .string()
        .optional()
        .describe("Git branch name"),
      worktree: z
        .string()
        .optional()
        .describe("Absolute worktree path"),
    },
    async ({ session_id, status, commit, branch, worktree }) => {
      try {
        const meta = await store.updateSession(session_id, {
          status: status as SessionStatus | undefined,
          commit,
          branch,
          worktree,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ updated: true, metadata: meta }, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "session_bus_list_sessions",
    "List all registered sessions. Optionally filter by status or parent session ID. Returns sessions sorted by most recently updated first.",
    {
      status: z
        .enum([...VALID_SESSION_STATUSES] as [string, ...string[]])
        .optional()
        .describe("Filter by session status"),
      parent_session_id: z
        .string()
        .optional()
        .describe("Filter by parent session ID (find children of a coordinator)"),
    },
    async ({ status, parent_session_id }) => {
      try {
        const sessions = await store.listSessions({
          status: status as SessionStatus | undefined,
          parent_session_id,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { sessions, count: sessions.length },
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
