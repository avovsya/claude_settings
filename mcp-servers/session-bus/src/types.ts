/**
 * Error codes returned by session bus operations.
 */
export const BusErrorCode = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  WRITE_FAILED: "WRITE_FAILED",
  CORRUPT_DATA: "CORRUPT_DATA",
  INVALID_SESSION_ID: "INVALID_SESSION_ID",
  INVALID_EVENT_TYPE: "INVALID_EVENT_TYPE",
  INVALID_STATUS: "INVALID_STATUS",
  DIR_NOT_WRITABLE: "DIR_NOT_WRITABLE",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type BusErrorCode = (typeof BusErrorCode)[keyof typeof BusErrorCode];

export class BusError extends Error {
  constructor(
    public readonly code: BusErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BusError";
  }
}

/** Format an error as an MCP tool error result */
export function errorResult(err: unknown) {
  const message =
    err instanceof BusError
      ? `[${err.code}] ${err.message}`
      : `Error: ${err instanceof Error ? err.message : String(err)}`;
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Session lifecycle status */
export type SessionStatus =
  | "active"
  | "idle"
  | "completed"
  | "partial"
  | "blocked"
  | "dead";

/** Session metadata stored in metadata.json */
export interface SessionMetadata {
  session_id: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;

  branch?: string;
  worktree?: string;
  parent_session_id?: string;

  completed_at?: string;
  commit?: string;
}

/** Event types published on the bus */
export type EventType =
  | "phase_complete"
  | "plan_ready"
  | "blocked"
  | "error"
  | "wip_committed"
  | "split_requested"
  | "build_result"
  | "session_started"
  | "context_warning";

/** An event published to the bus */
export interface BusEvent {
  session_id: string;
  timestamp: string;
  sequence: number;
  event_type: EventType;
  data: Record<string, unknown>;
}

/** Valid event types for validation */
export const VALID_EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  "phase_complete",
  "plan_ready",
  "blocked",
  "error",
  "wip_committed",
  "split_requested",
  "build_result",
  "session_started",
  "context_warning",
]);

/** Valid session statuses for validation */
export const VALID_SESSION_STATUSES: ReadonlySet<string> = new Set<SessionStatus>([
  "active",
  "idle",
  "completed",
  "partial",
  "blocked",
  "dead",
]);

/** Terminal statuses that set completed_at */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set<SessionStatus>([
  "completed",
  "partial",
  "blocked",
  "dead",
]);

/** Session ID validation: alphanumeric, hyphens, underscores, max 128 chars */
export const SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const SESSION_ID_MAX_LENGTH = 128;

/** Default max age for garbage collection (7 days in hours) */
export const DEFAULT_GC_MAX_AGE_HOURS = 168;

/** Event filename pattern: {timestamp}-{seq}-{type}.json */
export const EVENT_FILE_REGEX = /^(\d+)-(\d+)-(.+)\.json$/;
