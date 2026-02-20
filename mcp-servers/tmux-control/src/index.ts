#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkTmuxHealth } from "./tmux.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerPaneTools } from "./tools/panes.js";
import { registerDetectionTools } from "./tools/detection.js";
import { registerClaudeTools } from "./tools/claude.js";

const server = new McpServer({
  name: "tmux-control",
  version: "1.0.0",
});

// Register all tool groups
registerSessionTools(server);
registerPaneTools(server);
registerDetectionTools(server);
registerClaudeTools(server);

async function main() {
  await checkTmuxHealth();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[tmux-control] MCP server running on stdio");
}

main().catch((error) => {
  console.error("[tmux-control] Fatal error:", error);
  process.exit(1);
});
