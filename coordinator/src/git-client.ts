import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 120_000;

export interface GitWorktree {
  path: string;
  head: string;
  branch: string;
}

export class GitClient {
  constructor(
    private readonly mainWorktree: string,
    private readonly log: Logger,
  ) {}

  private async exec(
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cwd = options?.cwd ?? this.mainWorktree;
    const timeout = options?.timeout ?? GIT_TIMEOUT_MS;

    this.log.debug("git command", { args, cwd });

    try {
      const result = await execFileAsync("git", args, {
        cwd,
        timeout,
        encoding: "utf8",
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (err: any) {
      const exitCode = err.code ?? 1;
      this.log.debug("git command failed", {
        args,
        exitCode,
        stderr: err.stderr?.slice(0, 500),
      });
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode: typeof exitCode === "number" ? exitCode : 1,
      };
    }
  }

  async worktreeList(): Promise<GitWorktree[]> {
    const { stdout } = await this.exec(["worktree", "list", "--porcelain"]);
    const worktrees: GitWorktree[] = [];
    let current: Partial<GitWorktree> = {};

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current as GitWorktree);
        current = { path: line.slice(9) };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7).replace("refs/heads/", "");
      } else if (line === "bare") {
        current.branch = "(bare)";
      } else if (line === "detached") {
        current.branch = "(detached)";
      }
    }
    if (current.path) worktrees.push(current as GitWorktree);

    return worktrees;
  }

  async worktreeAdd(branch: string, path: string): Promise<{ success: boolean; error?: string }> {
    this.log.info("Creating git worktree", { branch, path });
    const result = await this.exec(["worktree", "add", "-b", branch, path, "main"]);

    if (result.exitCode !== 0) {
      this.log.error("Failed to create worktree", {
        branch,
        path,
        stderr: result.stderr,
      });
      return { success: false, error: result.stderr.trim() };
    }

    return { success: true };
  }

  /**
   * Remove a worktree. NEVER uses --force.
   * Will fail (safely) if there are uncommitted changes.
   */
  async worktreeRemove(path: string): Promise<{ success: boolean; error?: string }> {
    this.log.info("Removing git worktree", { path });
    const result = await this.exec(["worktree", "remove", path]);

    if (result.exitCode !== 0) {
      this.log.error("Failed to remove worktree (may have uncommitted changes)", {
        path,
        stderr: result.stderr,
      });
      return { success: false, error: result.stderr.trim() };
    }

    return { success: true };
  }

  /**
   * Merge a branch into main. Always uses --no-ff.
   */
  async merge(
    branch: string,
    message?: string,
  ): Promise<{ success: boolean; error?: string; commit?: string }> {
    this.log.info("Merging branch", { branch, message });

    // Ensure we're on main
    const checkoutResult = await this.exec(["checkout", "main"]);
    if (checkoutResult.exitCode !== 0) {
      return { success: false, error: `Failed to checkout main: ${checkoutResult.stderr}` };
    }

    const mergeArgs = ["merge", branch, "--no-ff"];
    if (message) {
      mergeArgs.push("-m", message);
    }

    const result = await this.exec(mergeArgs, { timeout: MERGE_TIMEOUT_MS });

    if (result.exitCode !== 0) {
      this.log.error("Merge failed", { branch, stderr: result.stderr });
      // Abort the failed merge
      await this.exec(["merge", "--abort"]);
      return { success: false, error: result.stderr.trim() };
    }

    // Get the merge commit hash
    const logResult = await this.exec(["rev-parse", "HEAD"]);
    const commit = logResult.stdout.trim();

    this.log.info("Merge completed", { branch, commit });
    return { success: true, commit };
  }

  /**
   * Delete a branch. Always uses lowercase -d (refuses to delete unmerged).
   * NEVER uses -D.
   */
  async branchDelete(branch: string): Promise<{ success: boolean; error?: string }> {
    this.log.info("Deleting branch", { branch });
    const result = await this.exec(["branch", "-d", branch]);

    if (result.exitCode !== 0) {
      this.log.error("Failed to delete branch", { branch, stderr: result.stderr });
      return { success: false, error: result.stderr.trim() };
    }

    return { success: true };
  }

  async isBranchMerged(branch: string): Promise<boolean> {
    const result = await this.exec(["branch", "--merged", "main"]);
    // Parse line-by-line to avoid substring false positives
    // git branch output has 2-char prefix (e.g. "  " or "* ")
    return result.stdout
      .split("\n")
      .some((line) => line.slice(2).trim() === branch);
  }

  async branchExists(branch: string): Promise<boolean> {
    const result = await this.exec(["rev-parse", "--verify", `refs/heads/${branch}`]);
    return result.exitCode === 0;
  }

  async status(cwd?: string): Promise<string> {
    const result = await this.exec(["status", "--porcelain"], { cwd });
    return result.stdout;
  }

  async lastCommit(cwd?: string): Promise<{ hash: string; time: string; message: string } | null> {
    const result = await this.exec(
      ["log", "-1", "--format=%H\t%cI\t%s"],
      { cwd },
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;

    const [hash, time, message] = result.stdout.trim().split("\t");
    return { hash: hash ?? "", time: time ?? "", message: message ?? "" };
  }

  async diff(branch: string): Promise<string> {
    const result = await this.exec(["diff", `main..${branch}`, "--stat"]);
    return result.stdout;
  }

  /**
   * Check if there are submodules in the main worktree.
   */
  async hasSubmodules(): Promise<boolean> {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    return existsSync(join(this.mainWorktree, ".gitmodules"));
  }

  /**
   * Get submodule paths from .gitmodules.
   */
  async getSubmodulePaths(): Promise<string[]> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    try {
      const content = await readFile(join(this.mainWorktree, ".gitmodules"), "utf8");
      const paths: string[] = [];
      for (const line of content.split("\n")) {
        const match = line.match(/^\s*path\s*=\s*(.+)$/);
        if (match) paths.push(match[1].trim());
      }
      return paths;
    } catch {
      return [];
    }
  }

  /**
   * Copy submodules from main worktree to a target worktree.
   */
  async copySubmodules(targetWorktree: string): Promise<void> {
    const { cp, mkdir } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const { existsSync } = await import("node:fs");

    const submodules = await this.getSubmodulePaths();
    for (const subpath of submodules) {
      const src = join(this.mainWorktree, subpath);
      const dst = join(targetWorktree, subpath);

      if (!existsSync(src)) {
        this.log.warn("Submodule source not found, skipping", { subpath });
        continue;
      }

      await mkdir(dirname(dst), { recursive: true });
      try {
        await cp(src, dst, { recursive: true });
        this.log.debug("Copied submodule", { subpath });
      } catch (err) {
        this.log.warn("Failed to copy submodule", {
          subpath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
