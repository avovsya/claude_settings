#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  ApprovalRow,
  CoordinatorStateRow,
  MergeQueueRow,
  WorkerRow,
} from "../types.js";

const HOME = process.env.HOME ?? "";
const DB_PATH = join(HOME, ".claude/coordinator/coordinator.db");
const DECISIONS_DIR = join(HOME, ".claude/coordinator/decisions");
const SPAWN_REQUESTS_DIR = join(HOME, ".claude/coordinator/spawn-requests");
const PID_PATH = join(HOME, ".claude/coordinator/coordinator.pid");
const SESSION_BUS_DIR = join(HOME, ".claude/session-bus/sessions");

function usage(): never {
  console.log(`Usage: coord <command> [options]

Commands:
  status                      Show coordinator and worker status
  list                        Show pending approvals
  approve [session-id]        Approve a pending plan or merge
  reject <session-id> <reason> Reject a pending plan or merge
  spawn <card-name>           Request coordinator to spawn a worker
  logs <session-id>           Show session-bus events for a worker
  stop                        Stop the coordinator daemon

Options:
  --changes <text>            Include feedback with an approval
  --help                      Show this help message
`);
  process.exit(0);
}

function openDB(): Database.Database {
  if (!existsSync(DB_PATH)) {
    console.error("Coordinator database not found. Is the coordinator running?");
    console.error(`Expected: ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: false });
  db.pragma("busy_timeout = 5000");
  return db;
}

function getCoordinatorPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
  if (isNaN(pid)) return null;

  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

// --- Commands ---

function cmdStatus(): void {
  const pid = getCoordinatorPid();
  console.log(`Coordinator: ${pid ? `Running (PID ${pid})` : "Not running"}`);
  console.log();

  if (!existsSync(DB_PATH)) {
    console.log("No database found. Start the coordinator first.");
    return;
  }

  const db = openDB();

  // Workers
  const workers = db
    .prepare("SELECT * FROM workers ORDER BY spawned_at DESC")
    .all() as WorkerRow[];

  if (workers.length === 0) {
    console.log("No workers registered.");
  } else {
    console.log("Workers:");
    console.log(
      "  " +
        [
          "Session ID".padEnd(22),
          "Status".padEnd(18),
          "Branch".padEnd(30),
          "Phase",
          "tmux",
        ].join("  "),
    );
    console.log("  " + "-".repeat(90));

    for (const w of workers) {
      const tmuxStatus = w.tmux_session ?? "-";
      console.log(
        "  " +
          [
            w.session_id.padEnd(22),
            w.status.padEnd(18),
            (w.branch ?? "-").padEnd(30),
            String(w.start_phase ?? "-").padEnd(5),
            tmuxStatus,
          ].join("  "),
      );
    }
  }

  // Pending approvals
  const approvals = db
    .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at")
    .all() as ApprovalRow[];

  if (approvals.length > 0) {
    console.log();
    console.log("Pending Approvals:");
    for (const a of approvals) {
      const ageMs = Date.now() - new Date(a.requested_at).getTime();
      const ageMin = Math.floor(ageMs / 60_000);
      console.log(
        `  [${a.approval_type}] ${a.session_id} — waiting ${ageMin}m${a.plan_path ? ` — ${a.plan_path}` : ""}`,
      );
    }
  }

  // Merge queue
  const merges = db
    .prepare("SELECT * FROM merge_queue WHERE status IN ('queued', 'merging') ORDER BY position")
    .all() as MergeQueueRow[];

  if (merges.length > 0) {
    console.log();
    console.log("Merge Queue:");
    for (const m of merges) {
      console.log(`  [${m.status}] ${m.session_id} — ${m.branch}`);
    }
  }

  db.close();
}

function cmdList(): void {
  const db = openDB();

  const approvals = db
    .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at")
    .all() as ApprovalRow[];

  if (approvals.length === 0) {
    console.log("No pending approvals.");
    db.close();
    return;
  }

  for (const a of approvals) {
    const ageMs = Date.now() - new Date(a.requested_at).getTime();
    const ageMin = Math.floor(ageMs / 60_000);
    console.log(`\n[${a.approval_type.toUpperCase()}] Session: ${a.session_id}`);
    console.log(`  Waiting: ${ageMin} minutes`);
    if (a.plan_path) {
      console.log(`  Plan: ${a.plan_path}`);
    }
    console.log(`  To approve: coord approve ${a.session_id}`);
    console.log(`  To reject:  coord reject ${a.session_id} "reason"`);
  }

  db.close();
}

function cmdApprove(sessionId?: string, changes?: string): void {
  const db = openDB();

  // If no session ID, approve the first pending
  if (!sessionId) {
    const first = db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at LIMIT 1")
      .get() as ApprovalRow | undefined;

    if (!first) {
      console.log("No pending approvals.");
      db.close();
      return;
    }
    sessionId = first.session_id;
    console.log(`Approving: ${sessionId} (${first.approval_type})`);
  }

  // Verify there's a pending approval for this session
  const approval = db
    .prepare(
      "SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    )
    .get(sessionId) as ApprovalRow | undefined;

  if (!approval) {
    console.error(`No pending approval found for session: ${sessionId}`);
    db.close();
    process.exit(1);
  }

  // Write decision file
  mkdirSync(DECISIONS_DIR, { recursive: true });
  const decision = {
    session_id: sessionId,
    decision: "approved",
    feedback: changes,
    decided_at: new Date().toISOString(),
  };
  const decisionPath = join(DECISIONS_DIR, `${sessionId}.json`);
  writeFileSync(decisionPath, JSON.stringify(decision, null, 2), "utf8");

  console.log(`Approved: ${sessionId} (${approval.approval_type})`);
  if (changes) {
    console.log(`Feedback: ${changes}`);
  }
  console.log(`Decision written to: ${decisionPath}`);
  console.log("The coordinator will deliver this to the worker on the next poll cycle.");

  db.close();
}

function cmdReject(sessionId: string, reason: string): void {
  if (!sessionId) {
    console.error("Usage: coord reject <session-id> <reason>");
    process.exit(1);
  }
  if (!reason) {
    console.error("A rejection reason is required.");
    process.exit(1);
  }

  const db = openDB();

  const approval = db
    .prepare(
      "SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    )
    .get(sessionId) as ApprovalRow | undefined;

  if (!approval) {
    console.error(`No pending approval found for session: ${sessionId}`);
    db.close();
    process.exit(1);
  }

  // Write decision file
  mkdirSync(DECISIONS_DIR, { recursive: true });
  const decision = {
    session_id: sessionId,
    decision: "rejected",
    feedback: reason,
    decided_at: new Date().toISOString(),
  };
  const decisionPath = join(DECISIONS_DIR, `${sessionId}.json`);
  writeFileSync(decisionPath, JSON.stringify(decision, null, 2), "utf8");

  console.log(`Rejected: ${sessionId} (${approval.approval_type})`);
  console.log(`Reason: ${reason}`);

  db.close();
}

function cmdSpawn(cardName: string): void {
  if (!cardName) {
    console.error("Usage: coord spawn <card-name>");
    process.exit(1);
  }

  mkdirSync(SPAWN_REQUESTS_DIR, { recursive: true });
  const request = {
    card_name: cardName,
    remaining_splits: 2,
    start_phase: 1,
    requested_at: new Date().toISOString(),
  };
  const requestPath = join(SPAWN_REQUESTS_DIR, `${Date.now()}.json`);
  writeFileSync(requestPath, JSON.stringify(request, null, 2), "utf8");

  console.log(`Spawn request created for: ${cardName}`);
  console.log("The coordinator will process this on the next poll cycle.");
}

function cmdLogs(sessionId: string): void {
  if (!sessionId) {
    console.error("Usage: coord logs <session-id>");
    process.exit(1);
  }

  const sessionDir = join(SESSION_BUS_DIR, sessionId);

  let files: string[];
  try {
    files = readdirSync(sessionDir) as string[];
  } catch {
    console.error(`Session not found: ${sessionId}`);
    console.error(`Expected directory: ${sessionDir}`);
    process.exit(1);
    return;
  }

  // Read metadata
  const metaPath = join(sessionDir, "metadata.json");
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    console.log(`Session: ${meta.session_id}`);
    console.log(`Status:  ${meta.status}`);
    console.log(`Branch:  ${meta.branch ?? "-"}`);
    console.log(`Created: ${meta.created_at}`);
    if (meta.completed_at) console.log(`Completed: ${meta.completed_at}`);
    if (meta.commit) console.log(`Commit: ${meta.commit}`);
    console.log();
  }

  // Read events
  const eventFiles = files
    .filter((f: string) => /^\d+-\d+-.+\.json$/.test(f) && !f.endsWith(".tmp"))
    .sort();

  if (eventFiles.length === 0) {
    console.log("No events.");
    return;
  }

  console.log("Events:");
  for (const file of eventFiles) {
    try {
      const event = JSON.parse(readFileSync(join(sessionDir, file), "utf8"));
      const time = event.timestamp?.slice(11, 19) ?? "?";
      const dataStr = event.data ? JSON.stringify(event.data) : "";
      console.log(`  ${time} [${event.event_type}] ${dataStr}`);
    } catch {
      console.log(`  (corrupt: ${file})`);
    }
  }
}

function cmdStop(): void {
  const pid = getCoordinatorPid();
  if (!pid) {
    console.log("Coordinator is not running.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to coordinator (PID ${pid})`);
  } catch (err) {
    console.error(`Failed to stop coordinator:`, err);
    process.exit(1);
  }
}

// --- Main ---

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "status":
      cmdStatus();
      break;

    case "list":
      cmdList();
      break;

    case "approve": {
      const changesIdx = args.indexOf("--changes");
      const changes = changesIdx >= 0 ? args[changesIdx + 1] : undefined;
      // Session ID is the first non-flag argument after "approve"
      const sessionId = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      cmdApprove(sessionId, changes);
      break;
    }

    case "reject":
      cmdReject(args[1], args.slice(2).join(" "));
      break;

    case "spawn":
      cmdSpawn(args.slice(1).join(" "));
      break;

    case "logs":
      cmdLogs(args[1]);
      break;

    case "stop":
      cmdStop();
      break;

    case "--help":
    case "-h":
    case undefined:
      usage();

    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main();
