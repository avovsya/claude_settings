#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileEventStore } from "./store.js";
import { registerPublishTools } from "./tools/publish.js";
import { registerEventTools } from "./tools/events.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerGcTools } from "./tools/gc.js";
import { DEFAULT_GC_MAX_AGE_HOURS } from "./types.js";

const baseDir = process.env.SESSION_BUS_DIR ?? join(homedir(), ".claude", "session-bus");

const store = new FileEventStore(baseDir);

const server = new McpServer({
  name: "session-bus",
  version: "1.0.0",
});

// Register all tool groups
registerPublishTools(server, store);
registerEventTools(server, store);
registerSessionTools(server, store);
registerGcTools(server, store);

async function main() {
  // Ensure base directory exists and is writable
  await store.ensureBaseDir();
  console.error(`[session-bus] Base directory: ${baseDir}`);

  // Rebuild sequence counters from existing event files
  await store.rebuildSequences();
  console.error("[session-bus] Sequence counters rebuilt");

  // Auto-GC on startup: clean terminal sessions older than 7 days
  try {
    const gcResult = await store.garbageCollect({
      maxAgeHours: DEFAULT_GC_MAX_AGE_HOURS,
      dryRun: false,
    });
    if (gcResult.sessions_deleted > 0 || gcResult.events_deleted > 0) {
      console.error(
        `[session-bus] Auto-GC: ${gcResult.sessions_deleted} sessions, ${gcResult.events_deleted} events deleted`,
      );
    }
  } catch (err) {
    console.error("[session-bus] Auto-GC warning:", err);
  }

  // Health check
  const health = await store.health();
  console.error(
    `[session-bus] Health: ${health.ok ? "OK" : "DEGRADED"} (${health.session_count} sessions)`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[session-bus] MCP server running on stdio");
}

main().catch((error) => {
  console.error("[session-bus] Fatal error:", error);
  process.exit(1);
});
