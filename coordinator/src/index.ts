#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Coordinator } from "./coordinator.js";
import { DEFAULT_CONFIG, type CoordinatorConfig } from "./types.js";

function usage(): never {
  console.log(`Usage: coordinator [options]

Options:
  --main-worktree <path>   Path to the main git worktree (required)
  --poll-interval <ms>     Poll interval in milliseconds (default: 30000)
  --log-level <level>      Log level: debug|info|warn|error (default: info)
  --help                   Show this help message

The coordinator daemon manages Claude Code worker sessions.
It polls session-bus for events, manages tmux sessions, and
surfaces human approval gates via the 'coord' CLI tool.
`);
  process.exit(0);
}

function parseArgs(argv: string[]): CoordinatorConfig {
  const config = { ...DEFAULT_CONFIG };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--main-worktree":
        config.mainWorktree = resolve(argv[++i] ?? "");
        break;
      case "--poll-interval":
        config.pollIntervalMs = parseInt(argv[++i] ?? "30000", 10);
        break;
      case "--help":
      case "-h":
        usage();
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  if (!config.mainWorktree) {
    // Try to detect from cwd
    config.mainWorktree = process.cwd();
  }

  return config;
}

function acquirePidLock(pidPath: string): void {
  mkdirSync(dirname(pidPath), { recursive: true });

  if (existsSync(pidPath)) {
    const existingPid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (!isNaN(existingPid)) {
      try {
        // Check if process is still alive
        process.kill(existingPid, 0);
        console.error(
          `Coordinator already running (PID ${existingPid}). Use 'coord stop' to stop it.`,
        );
        process.exit(1);
      } catch {
        // Process is dead, stale PID file
        console.error(`Removing stale PID file (PID ${existingPid} is dead)`);
      }
    }
  }

  writeFileSync(pidPath, String(process.pid), "utf8");
}

function releasePidLock(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv);

  // Step 1: Acquire PID lock (before anything else)
  acquirePidLock(config.pidPath);

  // Create required directories
  mkdirSync(config.decisionsDir, { recursive: true });
  mkdirSync(config.spawnRequestsDir, { recursive: true });

  const coordinator = new Coordinator(config);

  // Step 2: Register signal handlers
  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}, shutting down...`);
    await coordinator.shutdown();
    releasePidLock(config.pidPath);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Step 3: Start the coordinator
  try {
    await coordinator.start();
  } catch (err) {
    console.error("Failed to start coordinator:", err);
    releasePidLock(config.pidPath);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
