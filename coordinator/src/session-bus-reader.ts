import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BusEventType, BusSessionStatus } from "./types.js";

/**
 * Read-only client for the session-bus file store.
 *
 * This imports the same file format as the session-bus MCP server
 * but only performs reads — no event publishing, no metadata writes.
 *
 * Concurrency contract: The session-bus MCP server and this reader
 * both operate on ~/.claude/session-bus/sessions/. This is safe because:
 * - Event files are written atomically (tmp + rename)
 * - Metadata files are written atomically (tmp + rename)
 * - This reader only reads, never writes (except for pre-registration)
 * - POSIX guarantees atomic rename on same filesystem
 */

const EVENT_FILE_REGEX = /^(\d+)-(\d+)-(.+)\.json$/;

export interface BusEvent {
  session_id: string;
  timestamp: string;
  sequence: number;
  event_type: BusEventType;
  data: Record<string, unknown>;
}

export interface SessionMetadata {
  session_id: string;
  status: BusSessionStatus;
  created_at: string;
  updated_at: string;
  branch?: string;
  worktree?: string;
  parent_session_id?: string;
  completed_at?: string;
  commit?: string;
}

export class SessionBusReader {
  private readonly sessionsDir: string;

  constructor(baseDir: string) {
    this.sessionsDir = join(baseDir, "sessions");
  }

  async init(): Promise<void> {
    // Verify the sessions directory exists (or can be created)
    try {
      await stat(this.sessionsDir);
    } catch {
      // Directory doesn't exist yet — that's fine, workers will create it
    }
  }

  async readEvents(
    sessionId: string,
    options: {
      eventTypes?: BusEventType[];
      since?: string;
      sinceSequence?: number;
      lastN?: number;
    } = {},
  ): Promise<BusEvent[]> {
    const dir = join(this.sessionsDir, sessionId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    // Filter to event files, sorted lexicographically (= chronological)
    const eventFiles = files
      .filter((f) => EVENT_FILE_REGEX.test(f) && !f.endsWith(".tmp"))
      .sort();

    let sinceMs: number | null = null;
    if (options.since) {
      sinceMs = new Date(options.since).getTime();
    }

    const typeFilter = options.eventTypes ? new Set(options.eventTypes) : null;

    let events: BusEvent[] = [];

    for (const file of eventFiles) {
      const event = await this.readJSON<BusEvent>(join(dir, file));
      if (!event) continue;

      // Filter by (timestamp, sequence) cursor
      if (sinceMs !== null) {
        const eventMs = new Date(event.timestamp).getTime();
        if (eventMs < sinceMs) continue;
        if (eventMs === sinceMs && options.sinceSequence !== undefined) {
          if (event.sequence <= options.sinceSequence) continue;
        }
        if (eventMs === sinceMs && options.sinceSequence === undefined) {
          // Strict greater-than on timestamp only
          continue;
        }
      }

      if (typeFilter && !typeFilter.has(event.event_type)) continue;

      events.push(event);
    }

    // Apply lastN
    if (options.lastN && options.lastN > 0 && events.length > options.lastN) {
      events = events.slice(-options.lastN);
    }

    return events;
  }

  async getSession(sessionId: string): Promise<SessionMetadata | null> {
    const metaPath = join(this.sessionsDir, sessionId, "metadata.json");
    return this.readJSON<SessionMetadata>(metaPath);
  }

  async listSessions(filters?: {
    status?: BusSessionStatus;
    parent_session_id?: string;
  }): Promise<SessionMetadata[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const sessions: SessionMetadata[] = [];

    for (const entry of entries) {
      const metaPath = join(this.sessionsDir, entry, "metadata.json");
      const meta = await this.readJSON<SessionMetadata>(metaPath);
      if (!meta) continue;

      if (filters?.status && meta.status !== filters.status) continue;
      if (filters?.parent_session_id && meta.parent_session_id !== filters.parent_session_id) {
        continue;
      }

      sessions.push(meta);
    }

    // Sort by updated_at descending
    sessions.sort((a, b) => {
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    return sessions;
  }

  /**
   * Pre-register a session. This is the one write the coordinator performs
   * on the session-bus, using the same atomic write pattern as FileEventStore.
   * Safe because each session_id is unique and no MCP server instance will
   * write to this session until the worker starts.
   */
  async preRegisterSession(
    sessionId: string,
    fields: { branch?: string; worktree?: string; parent_session_id?: string },
  ): Promise<void> {
    const { mkdir, writeFile, rename, rm } = await import("node:fs/promises");
    const sessionDir = join(this.sessionsDir, sessionId);
    await mkdir(sessionDir, { recursive: true });

    const now = new Date().toISOString();
    const meta: SessionMetadata = {
      session_id: sessionId,
      status: "active",
      created_at: now,
      updated_at: now,
      ...fields,
    };

    const metaPath = join(sessionDir, "metadata.json");
    const tmpPath = `${metaPath}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
    try {
      await rename(tmpPath, metaPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw new Error(
        `Failed to pre-register session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async readJSON<T>(filePath: string): Promise<T | null> {
    try {
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
}
