/**
 * Error codes returned by tmux operations.
 * Parsed from tmux stderr output and exit codes.
 */
export const TmuxErrorCode = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  SESSION_EXISTS: "SESSION_EXISTS",
  SERVER_NOT_RUNNING: "SERVER_NOT_RUNNING",
  TMUX_NOT_INSTALLED: "TMUX_NOT_INSTALLED",
  TMUX_TIMEOUT: "TMUX_TIMEOUT",
  INVALID_SESSION_NAME: "INVALID_SESSION_NAME",
  INVALID_PATH: "INVALID_PATH",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type TmuxErrorCode = (typeof TmuxErrorCode)[keyof typeof TmuxErrorCode];

export class TmuxError extends Error {
  constructor(
    public readonly code: TmuxErrorCode,
    message: string,
    public readonly command?: string,
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

/** Result from tmux list-sessions */
export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
  size: string;
}

/** Result from detect_prompt_type */
export interface PromptDetection {
  state:
    | "plan_mode"
    | "edit_acceptance"
    | "permission_prompt"
    | "idle"
    | "processing"
    | "unknown";
  confidence: number;
  last_lines: string[];
}

/** Session name validation regex */
export const SESSION_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
export const SESSION_NAME_MAX_LENGTH = 64;

/** Capture pane limits */
export const CAPTURE_MAX_LINES = 10000;
export const CAPTURE_DEFAULT_LINES = 50;

/** Timeout for tmux operations in milliseconds */
export const TMUX_TIMEOUT_MS = 10_000;

/** Format an error as an MCP tool error result */
export function errorResult(err: unknown) {
  const message =
    err instanceof TmuxError
      ? `[${err.code}] ${err.message}`
      : `Error: ${err instanceof Error ? err.message : String(err)}`;
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
