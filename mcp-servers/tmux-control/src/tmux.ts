import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  TmuxError,
  TmuxErrorCode,
  TMUX_TIMEOUT_MS,
  SESSION_NAME_REGEX,
  SESSION_NAME_MAX_LENGTH,
} from "./types.js";

/**
 * Execute a tmux command with argument array (no shell interpretation).
 * Parses stderr for known error patterns and returns structured errors.
 */
export function execTmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = `tmux ${args.join(" ")}`;
    console.error(`[tmux-control] exec: ${cmd}`);

    execFile("tmux", args, { timeout: TMUX_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        // Check for timeout
        if (error.killed || error.code === "ETIMEDOUT") {
          reject(new TmuxError(TmuxErrorCode.TMUX_TIMEOUT, `tmux operation timed out after ${TMUX_TIMEOUT_MS}ms`, cmd));
          return;
        }

        // Check for tmux not installed (exit code 127 or ENOENT)
        if ("code" in error && (error.code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOENT")) {
          reject(new TmuxError(TmuxErrorCode.TMUX_NOT_INSTALLED, "tmux is not installed or not in PATH", cmd));
          return;
        }

        const stderrStr = stderr.trim();
        const parsed = parseTmuxError(stderrStr, cmd);
        if (parsed) {
          reject(parsed);
          return;
        }

        // Fallback: unknown error
        reject(new TmuxError(TmuxErrorCode.UNKNOWN_ERROR, stderrStr || error.message, cmd));
        return;
      }

      resolve(stdout);
    });
  });
}

/**
 * Parse tmux stderr into a structured TmuxError.
 * Returns null if the pattern is not recognized.
 */
function parseTmuxError(stderr: string, cmd: string): TmuxError | null {
  if (stderr.includes("can't find session:")) {
    return new TmuxError(TmuxErrorCode.SESSION_NOT_FOUND, stderr, cmd);
  }
  if (stderr.includes("can't find pane:")) {
    return new TmuxError(TmuxErrorCode.TARGET_NOT_FOUND, stderr, cmd);
  }
  if (stderr.includes("can't find window:")) {
    return new TmuxError(TmuxErrorCode.TARGET_NOT_FOUND, stderr, cmd);
  }
  if (stderr.includes("duplicate session:")) {
    return new TmuxError(TmuxErrorCode.SESSION_EXISTS, stderr, cmd);
  }
  if (stderr.includes("error connecting to")) {
    return new TmuxError(TmuxErrorCode.SERVER_NOT_RUNNING, "tmux server is not running (no active sessions)", cmd);
  }
  return null;
}

/**
 * Validate a tmux session name.
 * Must match ^[a-z0-9][a-z0-9-]*$ and be <= 64 chars.
 */
export function validateSessionName(name: string): void {
  if (!name) {
    throw new TmuxError(TmuxErrorCode.INVALID_SESSION_NAME, "Session name cannot be empty");
  }
  if (name.length > SESSION_NAME_MAX_LENGTH) {
    throw new TmuxError(
      TmuxErrorCode.INVALID_SESSION_NAME,
      `Session name too long (${name.length} chars, max ${SESSION_NAME_MAX_LENGTH}). Got: "${name}"`,
    );
  }
  if (!SESSION_NAME_REGEX.test(name)) {
    throw new TmuxError(
      TmuxErrorCode.INVALID_SESSION_NAME,
      `Invalid session name: "${name}". Must match ^[a-z0-9][a-z0-9-]*$ (lowercase alphanumeric and hyphens, cannot start with hyphen)`,
    );
  }
}

/**
 * Validate and resolve a working directory path.
 * Returns the resolved absolute path.
 */
export function validatePath(path: string, label: string): string {
  const resolved = resolve(path);
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new TmuxError(TmuxErrorCode.INVALID_PATH, `${label} is not a directory: ${resolved}`);
    }
  } catch (err) {
    if (err instanceof TmuxError) throw err;
    throw new TmuxError(TmuxErrorCode.INVALID_PATH, `${label} does not exist: ${resolved}`);
  }
  return resolved;
}

/**
 * Validate that a file exists and is readable.
 * Returns the resolved absolute path.
 */
export function validateFile(path: string, label: string): string {
  const resolved = resolve(path);
  try {
    accessSync(resolved, constants.R_OK);
  } catch {
    throw new TmuxError(TmuxErrorCode.FILE_NOT_FOUND, `${label} not found or not readable: ${resolved}`);
  }
  return resolved;
}

/**
 * Build a tmux target string for session:window.pane
 */
export function buildTarget(session: string, pane?: number): string {
  if (pane !== undefined) {
    return `${session}:.${pane}`;
  }
  return session;
}

/**
 * Check if tmux is available. Logs version to stderr.
 */
export async function checkTmuxHealth(): Promise<void> {
  try {
    const version = await execTmux(["-V"]);
    console.error(`[tmux-control] ${version.trim()} detected`);
  } catch (err) {
    if (err instanceof TmuxError && err.code === TmuxErrorCode.TMUX_NOT_INSTALLED) {
      console.error("[tmux-control] WARNING: tmux is not installed or not in PATH");
    } else {
      console.error("[tmux-control] WARNING: tmux health check failed:", err);
    }
  }
}
