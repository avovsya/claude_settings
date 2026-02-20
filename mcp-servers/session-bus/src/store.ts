import { mkdir, readdir, readFile, rename, stat, rm, writeFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import {
  BusError,
  BusErrorCode,
  EVENT_FILE_REGEX,
  SESSION_ID_MAX_LENGTH,
  SESSION_ID_REGEX,
  TERMINAL_STATUSES,
  VALID_EVENT_TYPES,
  VALID_SESSION_STATUSES,
  type BusEvent,
  type EventType,
  type SessionMetadata,
  type SessionStatus,
} from "./types.js";

/**
 * File-based event store for the session bus.
 *
 * Directory layout:
 *   {baseDir}/sessions/{session_id}/metadata.json
 *   {baseDir}/sessions/{session_id}/{timestamp}-{seq}-{event_type}.json
 *
 * Concurrency model:
 *   - Lock-free: atomic writes via tmp+rename (POSIX guarantees)
 *   - Per-session sequence counters in memory (single-threaded Node.js)
 *   - Readers tolerate ENOENT (file deleted between readdir and read)
 */
export class FileEventStore {
  private readonly sessionsDir: string;
  private sequences = new Map<string, number>();

  constructor(private readonly baseDir: string) {
    this.sessionsDir = join(baseDir, "sessions");
  }

  /** Ensure the base directory exists and is writable */
  async ensureBaseDir(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    try {
      accessSync(this.sessionsDir, constants.W_OK);
    } catch {
      throw new BusError(
        BusErrorCode.DIR_NOT_WRITABLE,
        `Session bus directory is not writable: ${this.sessionsDir}`,
      );
    }
  }

  /** Rebuild sequence counters from existing event files */
  async rebuildSequences(): Promise<void> {
    let sessionIds: string[];
    try {
      sessionIds = await readdir(this.sessionsDir);
    } catch (err: unknown) {
      if (isEnoent(err)) return;
      throw err;
    }

    for (const sessionId of sessionIds) {
      const sessionDir = join(this.sessionsDir, sessionId);
      let files: string[];
      try {
        const entries = await stat(sessionDir);
        if (!entries.isDirectory()) continue;
        files = await readdir(sessionDir);
      } catch {
        continue;
      }

      let maxSeq = -1;
      for (const file of files) {
        const match = file.match(EVENT_FILE_REGEX);
        if (match) {
          const seq = parseInt(match[2], 10);
          if (seq > maxSeq) maxSeq = seq;
        }
      }

      if (maxSeq >= 0) {
        this.sequences.set(sessionId, maxSeq + 1);
      }
    }
  }

  // --- Validation ---

  validateSessionId(sessionId: string): void {
    if (!sessionId) {
      throw new BusError(BusErrorCode.INVALID_SESSION_ID, "Session ID cannot be empty");
    }
    if (sessionId.length > SESSION_ID_MAX_LENGTH) {
      throw new BusError(
        BusErrorCode.INVALID_SESSION_ID,
        `Session ID too long (${sessionId.length} chars, max ${SESSION_ID_MAX_LENGTH})`,
      );
    }
    if (!SESSION_ID_REGEX.test(sessionId)) {
      throw new BusError(
        BusErrorCode.INVALID_SESSION_ID,
        `Invalid session ID: "${sessionId}". Must be alphanumeric with hyphens/underscores.`,
      );
    }
  }

  validateEventType(eventType: string): asserts eventType is EventType {
    if (!VALID_EVENT_TYPES.has(eventType)) {
      throw new BusError(
        BusErrorCode.INVALID_EVENT_TYPE,
        `Invalid event type: "${eventType}". Valid types: ${[...VALID_EVENT_TYPES].join(", ")}`,
      );
    }
  }

  validateStatus(status: string): asserts status is SessionStatus {
    if (!VALID_SESSION_STATUSES.has(status)) {
      throw new BusError(
        BusErrorCode.INVALID_STATUS,
        `Invalid status: "${status}". Valid statuses: ${[...VALID_SESSION_STATUSES].join(", ")}`,
      );
    }
  }

  // --- Atomic File Operations ---

  private async atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
    const tmpPath = `${filePath}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
      await rename(tmpPath, filePath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw new BusError(
        BusErrorCode.WRITE_FAILED,
        `Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async readJSON<T>(filePath: string): Promise<T | null> {
    try {
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content) as T;
    } catch (err: unknown) {
      if (isEnoent(err)) return null;
      if (err instanceof SyntaxError) {
        console.error(`[session-bus] Corrupt JSON file: ${filePath}`);
        return null;
      }
      throw err;
    }
  }

  // --- Session Directory ---

  private sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  private metadataPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "metadata.json");
  }

  private async ensureSessionDir(sessionId: string): Promise<void> {
    await mkdir(this.sessionDir(sessionId), { recursive: true });
  }

  // --- Publish ---

  async publishEvent(
    sessionId: string,
    eventType: EventType,
    data: Record<string, unknown>,
  ): Promise<BusEvent> {
    this.validateSessionId(sessionId);
    this.validateEventType(eventType);

    await this.ensureSessionDir(sessionId);

    // Auto-register if no metadata exists
    const existing = await this.readJSON<SessionMetadata>(this.metadataPath(sessionId));
    if (!existing) {
      const now = new Date().toISOString();
      const meta: SessionMetadata = {
        session_id: sessionId,
        status: "active",
        created_at: now,
        updated_at: now,
      };
      await this.atomicWriteJSON(this.metadataPath(sessionId), meta);
    }

    // Get next sequence number
    const sequence = this.sequences.get(sessionId) ?? 0;
    this.sequences.set(sessionId, sequence + 1);

    const timestamp = new Date().toISOString();
    const event: BusEvent = {
      session_id: sessionId,
      timestamp,
      sequence,
      event_type: eventType,
      data,
    };

    // Filename: {ms_timestamp}-{seq}-{event_type}.json
    const msTimestamp = Date.now().toString().padStart(13, "0");
    const seqStr = sequence.toString().padStart(5, "0");
    const filename = `${msTimestamp}-${seqStr}-${eventType}.json`;
    const eventPath = join(this.sessionDir(sessionId), filename);

    await this.atomicWriteJSON(eventPath, event);

    // Update metadata.updated_at
    if (existing) {
      await this.atomicWriteJSON(this.metadataPath(sessionId), {
        ...existing,
        updated_at: timestamp,
      });
    }

    return event;
  }

  // --- Read Events ---

  async readEvents(
    sessionId: string,
    options: {
      eventTypes?: string[];
      since?: string;
      lastN?: number;
    } = {},
  ): Promise<BusEvent[]> {
    this.validateSessionId(sessionId);

    const dir = this.sessionDir(sessionId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err: unknown) {
      if (isEnoent(err)) return [];
      throw err;
    }

    // Filter to event files only, sorted lexicographically (= chronological)
    const eventFiles = files
      .filter((f) => EVENT_FILE_REGEX.test(f) && !f.endsWith(".tmp"))
      .sort();

    let sinceMs: number | null = null;
    if (options.since) {
      sinceMs = new Date(options.since).getTime();
      if (isNaN(sinceMs)) {
        throw new BusError(
          BusErrorCode.CORRUPT_DATA,
          `Invalid ISO 8601 timestamp for 'since': "${options.since}"`,
        );
      }
    }
    const typeFilter = options.eventTypes
      ? new Set(options.eventTypes)
      : null;

    let events: BusEvent[] = [];

    for (const file of eventFiles) {
      const event = await this.readJSON<BusEvent>(join(dir, file));
      if (!event) continue;

      // Apply filters
      if (sinceMs && new Date(event.timestamp).getTime() <= sinceMs) continue;
      if (typeFilter && !typeFilter.has(event.event_type)) continue;

      events.push(event);
    }

    // Apply lastN
    if (options.lastN && options.lastN > 0 && events.length > options.lastN) {
      events = events.slice(-options.lastN);
    }

    return events;
  }

  // --- Sessions ---

  async registerSession(
    sessionId: string,
    fields: {
      branch?: string;
      worktree?: string;
      parent_session_id?: string;
    } = {},
  ): Promise<SessionMetadata> {
    this.validateSessionId(sessionId);
    await this.ensureSessionDir(sessionId);

    const existing = await this.readJSON<SessionMetadata>(this.metadataPath(sessionId));
    const now = new Date().toISOString();

    let meta: SessionMetadata;
    if (existing) {
      // Merge: don't overwrite existing non-null fields
      meta = {
        ...existing,
        updated_at: now,
        branch: existing.branch ?? fields.branch,
        worktree: existing.worktree ?? fields.worktree,
        parent_session_id: existing.parent_session_id ?? fields.parent_session_id,
      };
    } else {
      meta = {
        session_id: sessionId,
        status: "active",
        created_at: now,
        updated_at: now,
        ...fields,
      };
    }

    await this.atomicWriteJSON(this.metadataPath(sessionId), meta);
    return meta;
  }

  async getSession(sessionId: string): Promise<SessionMetadata> {
    this.validateSessionId(sessionId);

    const meta = await this.readJSON<SessionMetadata>(this.metadataPath(sessionId));
    if (!meta) {
      throw new BusError(
        BusErrorCode.SESSION_NOT_FOUND,
        `Session not found: ${sessionId}`,
      );
    }

    return meta;
  }

  async updateSession(
    sessionId: string,
    updates: {
      status?: SessionStatus;
      commit?: string;
      branch?: string;
      worktree?: string;
    },
  ): Promise<SessionMetadata> {
    this.validateSessionId(sessionId);
    if (updates.status) this.validateStatus(updates.status);

    const existing = await this.readJSON<SessionMetadata>(this.metadataPath(sessionId));
    if (!existing) {
      throw new BusError(
        BusErrorCode.SESSION_NOT_FOUND,
        `Session not found: ${sessionId}`,
      );
    }

    const now = new Date().toISOString();
    const meta: SessionMetadata = {
      ...existing,
      ...updates,
      updated_at: now,
    };

    // Set completed_at for terminal statuses
    if (updates.status && TERMINAL_STATUSES.has(updates.status) && !existing.completed_at) {
      meta.completed_at = now;
    }

    await this.atomicWriteJSON(this.metadataPath(sessionId), meta);
    return meta;
  }

  async listSessions(
    filters: {
      status?: SessionStatus;
      parent_session_id?: string;
    } = {},
  ): Promise<SessionMetadata[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir);
    } catch (err: unknown) {
      if (isEnoent(err)) return [];
      throw err;
    }

    const sessions: SessionMetadata[] = [];

    for (const entry of entries) {
      const metaPath = join(this.sessionsDir, entry, "metadata.json");
      const meta = await this.readJSON<SessionMetadata>(metaPath);
      if (!meta) continue;

      // Apply filters
      if (filters.status && meta.status !== filters.status) continue;
      if (filters.parent_session_id && meta.parent_session_id !== filters.parent_session_id) {
        continue;
      }

      sessions.push(meta);
    }

    // Sort by updated_at descending (most recent first)
    sessions.sort((a, b) => {
      const aTime = new Date(a.updated_at).getTime();
      const bTime = new Date(b.updated_at).getTime();
      return bTime - aTime;
    });

    return sessions;
  }

  // --- Garbage Collection ---

  async garbageCollect(
    options: {
      maxAgeHours?: number;
      dryRun?: boolean;
      status?: SessionStatus;
    } = {},
  ): Promise<{
    sessions_deleted: number;
    events_deleted: number;
    bytes_freed: number;
    details: string[];
  }> {
    const maxAgeMs = (options.maxAgeHours ?? 168) * 60 * 60 * 1000;
    const dryRun = options.dryRun ?? false;
    const now = Date.now();
    const result = {
      sessions_deleted: 0,
      events_deleted: 0,
      bytes_freed: 0,
      details: [] as string[],
    };

    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir);
    } catch (err: unknown) {
      if (isEnoent(err)) return result;
      throw err;
    }

    for (const entry of entries) {
      const sessionDir = join(this.sessionsDir, entry);
      const meta = await this.readJSON<SessionMetadata>(
        join(sessionDir, "metadata.json"),
      );

      if (!meta) continue;

      // If status filter specified, only clean matching sessions
      if (options.status && meta.status !== options.status) continue;

      const updatedAt = new Date(meta.updated_at).getTime();
      const age = now - updatedAt;

      // For terminal sessions older than maxAge: delete entire directory
      if (TERMINAL_STATUSES.has(meta.status) && age > maxAgeMs) {
        const size = await dirSize(sessionDir);
        if (!dryRun) {
          await rm(sessionDir, { recursive: true, force: true });
          this.sequences.delete(entry);
        }
        result.sessions_deleted++;
        result.bytes_freed += size;
        result.details.push(
          `${dryRun ? "[dry-run] " : ""}Deleted session ${entry} (status: ${meta.status}, age: ${formatAge(age)})`,
        );
        continue;
      }

      // For active sessions: delete individual old events
      if (!TERMINAL_STATUSES.has(meta.status)) {
        let files: string[];
        try {
          files = await readdir(sessionDir);
        } catch {
          continue;
        }

        for (const file of files) {
          if (!EVENT_FILE_REGEX.test(file)) continue;

          const filePath = join(sessionDir, file);
          try {
            const fileStat = await stat(filePath);
            const fileAge = now - fileStat.mtimeMs;
            if (fileAge > maxAgeMs) {
              if (!dryRun) {
                await rm(filePath, { force: true });
              }
              result.events_deleted++;
              result.bytes_freed += fileStat.size;
              result.details.push(
                `${dryRun ? "[dry-run] " : ""}Deleted event ${file} from ${entry} (age: ${formatAge(fileAge)})`,
              );
            }
          } catch (err: unknown) {
            if (!isEnoent(err)) {
              console.error(`[session-bus] GC error on ${filePath}:`, err);
            }
          }
        }
      }
    }

    return result;
  }

  // --- Health ---

  async health(): Promise<{
    ok: boolean;
    base_dir: string;
    session_count: number;
    writable: boolean;
  }> {
    let writable = false;
    try {
      accessSync(this.sessionsDir, constants.W_OK);
      writable = true;
    } catch {
      // not writable
    }

    let sessionCount = 0;
    try {
      const entries = await readdir(this.sessionsDir);
      sessionCount = entries.length;
    } catch {
      // dir doesn't exist yet
    }

    return {
      ok: writable,
      base_dir: this.baseDir,
      session_count: sessionCount,
      writable,
    };
  }
}

// --- Helpers ---

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

async function dirSize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const files = await readdir(dirPath);
    for (const file of files) {
      try {
        const s = await stat(join(dirPath, file));
        total += s.size;
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return total;
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
