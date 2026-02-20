import { mkdirSync, appendFileSync, existsSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Structured JSON logger with file rotation.
 *
 * Writes JSON lines to a log file. Rotates daily, keeps 7 days.
 * Also outputs human-readable format to stderr for development.
 */
export class Logger {
  private logFile: string;
  private currentDate: string;
  private minLevel: number;
  private errorCounts = new Map<string, { count: number; lastAt: number }>();
  private static readonly ERROR_DEDUP_WINDOW_MS = 60_000;
  private static readonly ERROR_DEDUP_MAX = 5;

  constructor(
    private readonly logDir: string,
    level: LogLevel = "info",
  ) {
    mkdirSync(logDir, { recursive: true });
    this.minLevel = LOG_LEVELS[level];
    this.currentDate = this.today();
    this.logFile = join(logDir, `coordinator-${this.currentDate}.log`);
    this.rotateOldLogs();
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private checkRotation(): void {
    const today = this.today();
    if (today !== this.currentDate) {
      this.currentDate = today;
      this.logFile = join(this.logDir, `coordinator-${today}.log`);
      this.rotateOldLogs();
    }
  }

  private rotateOldLogs(): void {
    try {
      const files = readdirSync(this.logDir)
        .filter((f) => f.startsWith("coordinator-") && f.endsWith(".log"))
        .sort();

      // Keep only the last 7 days
      while (files.length > 7) {
        const oldest = files.shift()!;
        try {
          unlinkSync(join(this.logDir, oldest));
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore rotation errors
    }
  }

  private shouldDedup(message: string): boolean {
    const now = Date.now();
    const key = message;
    const entry = this.errorCounts.get(key);

    if (!entry || now - entry.lastAt > Logger.ERROR_DEDUP_WINDOW_MS) {
      this.errorCounts.set(key, { count: 1, lastAt: now });
      return false;
    }

    entry.count++;
    entry.lastAt = now;

    if (entry.count === Logger.ERROR_DEDUP_MAX + 1) {
      // Log one suppression notice
      this.writeEntry({
        timestamp: new Date().toISOString(),
        level: "warn",
        message: `Suppressing repeated error (>${Logger.ERROR_DEDUP_MAX}/min): ${message}`,
      });
    }

    return entry.count > Logger.ERROR_DEDUP_MAX;
  }

  private writeEntry(entry: LogEntry): void {
    this.checkRotation();

    // Write JSON to log file
    try {
      appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
    } catch {
      // If we can't write to the log file, at least try stderr
    }

    // Human-readable to stderr
    const levelTag = entry.level.toUpperCase().padEnd(5);
    const time = entry.timestamp.slice(11, 23);
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
    process.stderr.write(`${time} ${levelTag} ${entry.message}${dataStr}\n`);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.minLevel) return;

    if (level === "error" && this.shouldDedup(message)) return;

    this.writeEntry({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(data ? { data } : {}),
    });
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }
}
