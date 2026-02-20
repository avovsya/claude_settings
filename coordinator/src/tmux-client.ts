import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

const TMUX_TIMEOUT_MS = 10_000;

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export class TmuxClient {
  constructor(private readonly log: Logger) {}

  private async exec(
    args: string[],
    timeoutMs: number = TMUX_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync("tmux", args, {
        timeout: timeoutMs,
        encoding: "utf8",
      });
    } catch (err: any) {
      // tmux not running is not fatal for listing
      if (err.stderr?.includes("no server running") || err.stderr?.includes("no current client")) {
        return { stdout: "", stderr: err.stderr };
      }
      throw err;
    }
  }

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const { stdout } = await this.exec([
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}",
      ]);

      if (!stdout.trim()) return [];

      return stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [name, windows, created, attached] = line.split("\t");
          return {
            name: name ?? "",
            windows: parseInt(windows ?? "1", 10),
            created: created ?? "",
            attached: attached === "1",
          };
        })
        .filter((s) => s.name);
    } catch {
      return [];
    }
  }

  async createSession(name: string, cwd?: string): Promise<void> {
    const args = ["new-session", "-d", "-s", name];
    if (cwd) args.push("-c", cwd);

    this.log.info("Creating tmux session", { name, cwd });
    await this.exec(args);
  }

  async killSession(name: string): Promise<void> {
    this.log.info("Killing tmux session", { name });
    try {
      await this.exec(["kill-session", "-t", name]);
    } catch (err: any) {
      if (err.stderr?.includes("session not found")) {
        this.log.debug("Session already gone", { name });
        return;
      }
      throw err;
    }
  }

  async splitWindow(
    session: string,
    direction: "horizontal" | "vertical" = "vertical",
    percent: number = 30,
    cwd?: string,
  ): Promise<void> {
    const flag = direction === "horizontal" ? "-h" : "-v";
    const args = ["split-window", "-t", session, flag, "-p", String(percent)];
    if (cwd) args.push("-c", cwd);
    await this.exec(args);
  }

  async sendKeys(session: string, pane: number, text: string, enter: boolean = true): Promise<void> {
    const target = `${session}:.${pane}`;
    if (enter) {
      await this.exec(["send-keys", "-t", target, "-l", text]);
      await this.exec(["send-keys", "-t", target, "Enter"]);
    } else {
      await this.exec(["send-keys", "-t", target, "-l", text]);
    }
  }

  async capturePane(session: string, pane: number = 0, lines: number = 50): Promise<string> {
    const target = `${session}:.${pane}`;
    const { stdout } = await this.exec([
      "capture-pane",
      "-t",
      target,
      "-p",
      "-S",
      `-${lines}`,
    ]);
    return stdout;
  }

  /**
   * Launch Claude Code in a tmux pane.
   * Uses the reliable prompt_file method (cat file | claude).
   */
  async launchClaude(
    session: string,
    pane: number,
    options: {
      promptFile?: string;
      continueSession?: boolean;
      resumeId?: string;
      dangerouslySkipPermissions?: boolean;
    } = {},
  ): Promise<void> {
    const target = `${session}:.${pane}`;

    let cmd = "unset CLAUDECODE && ";

    if (options.promptFile) {
      cmd += `cat '${options.promptFile}' | claude`;
    } else {
      cmd += "claude";
    }

    if (options.dangerouslySkipPermissions) {
      cmd += " --dangerously-skip-permissions";
    }
    if (options.continueSession) {
      cmd += " --continue";
    }
    if (options.resumeId) {
      cmd += ` --resume '${options.resumeId}'`;
    }

    this.log.info("Launching Claude in tmux", { session, pane, cmd });
    await this.exec(["send-keys", "-t", target, "-l", cmd]);
    await this.exec(["send-keys", "-t", target, "Enter"]);
  }

  /**
   * Detect what state the Claude Code session is in.
   * Returns a heuristic based on the last few lines of the pane.
   */
  async detectPromptType(
    session: string,
    pane: number = 0,
  ): Promise<"idle" | "processing" | "permission_prompt" | "unknown"> {
    const content = await this.capturePane(session, pane, 30);
    const lines = content.trim().split("\n");
    const lastLines = lines.slice(-10).join("\n");

    // Check for idle state (Claude's input prompt)
    if (lastLines.match(/>\s*$/)) {
      return "idle";
    }

    // Check for permission prompts
    if (
      lastLines.includes("Allow?") ||
      lastLines.includes("(y/n)") ||
      lastLines.match(/\[\d+\]/)
    ) {
      return "permission_prompt";
    }

    // If there's a spinner or "thinking" indicator
    if (lastLines.includes("...") || lastLines.includes("thinking")) {
      return "processing";
    }

    return "unknown";
  }

  async interrupt(session: string, pane: number = 0): Promise<void> {
    const target = `${session}:.${pane}`;
    this.log.info("Interrupting Claude session", { session, pane });
    // Send Escape then Ctrl-C
    await this.exec(["send-keys", "-t", target, "Escape"]);
    await this.exec(["send-keys", "-t", target, "C-c"]);
  }

  async hasSession(name: string): Promise<boolean> {
    const sessions = await this.listSessions();
    return sessions.some((s) => s.name === name);
  }
}
