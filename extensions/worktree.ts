/**
 * Worktree Extension - Git worktree-based branch management
 *
 * Commands:
 *   /branch <name> [from]  — Switch to or create a branch with git worktree
 *   /unbranch              — Return to the original working directory
 *
 * When a worktree is active, all tool calls (bash, read, write, edit, ls,
 * find, grep) are transparently redirected to the worktree directory.
 * The session remains in the original project path so /resume works
 * normally, and on resume the worktree redirection is automatically restored.
 *
 * Priority (best to worst UX):
 *   1. Command + options:  /branch feature-a main       (no interaction)
 *   2. Only command:       /branch feature-a             (branch exists → direct;
 *                                                        branch missing → offer base)
 *   3. No args:            /branch                       (interactive selection)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const WORKTREE_CUSTOM_TYPE = "worktree";

interface WorktreeActive {
  path: string;
  branch: string;
  originalCwd: string;
}

interface WorktreeCleared {
  cleared: true;
}

type WorktreeEntry = WorktreeActive | WorktreeCleared;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isActive(entry: WorktreeEntry): entry is WorktreeActive {
  return "path" in entry;
}

/**
 * List all branches (local + remote), deduplicated.
 * Local branches appear first, then remote branches sorted alphabetically.
 */
async function listBranches(_cwd: string, pi: ExtensionAPI): Promise<string[]> {
  const { stdout } = await pi.exec(
    "git",
    ["branch", "-a", "--format=%(refname:short)"],
  );
  const lines = stdout.trim().split("\n").filter(Boolean);

  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    if (line.includes("->")) continue; // skip HEAD -> refs
    const cleaned = line.replace(/^remotes\//, "");
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }

  // Sort: local branches first, then remote
  return result.sort((a, b) => {
    const aRemote = a.includes("/") ? 1 : 0;
    const bRemote = b.includes("/") ? 1 : 0;
    if (aRemote !== bRemote) return aRemote - bRemote;
    return a.localeCompare(b);
  });
}

/** Check whether a branch exists locally. */
async function localBranchExists(
  _cwd: string,
  branch: string,
  pi: ExtensionAPI,
): Promise<boolean> {
  const { code } = await pi.exec(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
  );
  return code === 0;
}

/** Find the full remote ref for a branch name, e.g. "origin/main". */
async function findRemoteRef(
  _cwd: string,
  branch: string,
  pi: ExtensionAPI,
): Promise<string | null> {
  const { stdout } = await pi.exec(
    "git",
    ["branch", "-r", "--format=%(refname:short)"],
  );
  const remotes = stdout.trim().split("\n").filter(Boolean);
  // Prefer exact match, e.g. "origin/main" for branch "main"
  for (const ref of remotes) {
    if (ref === branch || ref.endsWith(`/${branch}`)) return ref;
  }
  return null;
}

/**
 * Recursively resolve string-valued "path-ish" keys inside a tool input to
 * absolute paths rooted at `baseDir`.  Keeps absolute / home-relative paths
 * unchanged.
 */
function redirectPaths(
  input: unknown,
  baseDir: string,
): void {
  if (!input || typeof input !== "object") return;
  const record = input as Record<string, unknown>;

  // Path-like keys that should be redirected
  const pathKeys = new Set(["path", "file", "directory", "cwd", "paths"]);

  for (const key of Object.keys(record)) {
    const val = record[key];

    if (typeof val === "string" && pathKeys.has(key)) {
      if (val && !path.isAbsolute(val) && !val.startsWith("~")) {
        record[key] = path.resolve(baseDir, val);
      }
    } else if (Array.isArray(val) && (key === "paths" || key === "path")) {
      record[key] = (val as string[]).map((p) =>
        typeof p === "string" && p && !path.isAbsolute(p) && !p.startsWith("~")
          ? path.resolve(baseDir, p)
          : p,
      );
    }
  }
}

/** Validate that we're inside a git repository. */
async function ensureGitRepo(
  _cwd: string,
  pi: ExtensionAPI,
): Promise<boolean> {
  const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
  return code === 0;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // In-memory worktree state for the current session instance.
  let currentWorktree: WorktreeActive | null = null;

  // -----------------------------------------------------------------------
  // Session start — restore worktree state from persisted entries
  // -----------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    currentWorktree = null;

    // Walk all entries in order; the last worktree entry wins.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === WORKTREE_CUSTOM_TYPE
      ) {
        const data = entry.data as WorktreeEntry;
        if (isActive(data)) {
          currentWorktree = data;
        } else {
          currentWorktree = null; // explicitly cleared
        }
      }
    }

    if (currentWorktree) {
      // Make sure the worktree directory still exists on disk.
      try {
        await fs.promises.access(currentWorktree.path);
      } catch {
        ctx.ui.notify(
          `Worktree directory missing: ${currentWorktree.path}`,
          "warning",
        );
        currentWorktree = null;
        return;
      }

      ctx.ui.setStatus("worktree", `🌿 ${currentWorktree.branch}`);
      ctx.ui.notify(
        `Worktree active — all tools redirect to: ${currentWorktree.path}`,
        "info",
      );
    }
  });

  // -----------------------------------------------------------------------
  // Tool call interception — redirect paths & cwd to worktree
  // -----------------------------------------------------------------------
  pi.on("tool_call", async (event, _ctx) => {
    if (!currentWorktree) return;
    const wt = currentWorktree.path;

    // --- bash ---
    if (event.toolName === "bash") {
      const input = event.input as { command: string; timeout?: number };
      input.command = `cd '${wt}' && ${input.command}`;
      return;
    }

    // --- read, write, edit, ls, find, grep ---
    // Resolve any path-like string/array parameters relative to the
    // worktree so the tools operate on the correct files.
    if (
      event.toolName === "read" ||
      event.toolName === "write" ||
      event.toolName === "edit" ||
      event.toolName === "ls" ||
      event.toolName === "find" ||
      event.toolName === "grep"
    ) {
      redirectPaths(event.input, wt);
    }
  });

  // -----------------------------------------------------------------------
  // Command: /branch <name> [from]
  // -----------------------------------------------------------------------
  pi.registerCommand("branch", {
    description: "Switch to or create a git branch with worktree",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const projectName = path.basename(cwd);

      // ── Validate git repo ──────────────────────────────────────────
      if (!(await ensureGitRepo(cwd, pi))) {
        ctx.ui.notify("Not a git repository (or no git installed)", "error");
        return;
      }

      // ── Parse arguments ────────────────────────────────────────────
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let branchName = parts[0];
      let fromBranch = parts[1];

      // ── No args: interactive branch selection ──────────────────────
      if (!branchName) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            "Usage: /branch <name> [from] — branch name required",
            "error",
          );
          return;
        }

        const branches = await listBranches(cwd, pi);
        if (branches.length === 0) {
          ctx.ui.notify("No branches found", "error");
          return;
        }

        branchName = await ctx.ui.select("Select a branch:", branches);
        if (!branchName) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
      }

      // ── Determine branch existence ─────────────────────────────────
      const existsLocally = await localBranchExists(cwd, branchName, pi);
      const remoteRef =
        !existsLocally ? await findRemoteRef(cwd, branchName, pi) : null;
      const branchExists = existsLocally || remoteRef !== null;

      // ── Branch missing & no base → offer base selection ────────────
      if (!branchExists && !fromBranch) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `Branch '${branchName}' not found. Specify base: /branch ${branchName} <from>`,
            "error",
          );
          return;
        }

        const branches = await listBranches(cwd, pi);
        // Put main / master at the top of the list
        const defaultBranch = branches.find(
          (b) => b === "main" || b === "master",
        );
        const sorted = defaultBranch
          ? [defaultBranch, ...branches.filter((b) => b !== defaultBranch)]
          : branches;

        fromBranch = await ctx.ui.select(
          `Branch '${branchName}' not found — create from which branch?`,
          sorted,
        );
        if (!fromBranch) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
      }

      // ── Build worktree path ────────────────────────────────────────
      const worktreeDir = path.resolve(
        cwd,
        ".pi",
        "worktree",
        projectName,
        branchName,
      );

      // Already exists? Just reactivate it
      try {
        await fs.promises.access(worktreeDir);
        currentWorktree = {
          path: worktreeDir,
          branch: branchName,
          originalCwd: cwd,
        };
        await pi.appendEntry(WORKTREE_CUSTOM_TYPE, currentWorktree);

        ctx.ui.setStatus("worktree", `🌿 ${branchName}`);
        ctx.ui.notify(
          `Worktree already exists — reactivated: ${worktreeDir}`,
          "info",
        );

        pi.sendMessage({
          customType: "worktree",
          content:
            `Now working in worktree directory: ${worktreeDir}\n` +
            `Branch: ${branchName}\n` +
            `All tool calls (bash, read, write, edit, ls, find, grep) operate relative to this directory.`,
          display: true,
        });
        return;
      } catch {
        // Directory doesn't exist — proceed to create it
      }

      // ── Assemble git worktree command ──────────────────────────────
      let gitArgs: string[];
      if (existsLocally) {
        // Local branch already exists
        gitArgs = ["worktree", "add", worktreeDir, branchName];
      } else if (remoteRef) {
        // Remote-only branch — create local tracking branch
        gitArgs = ["worktree", "add", "-b", branchName, worktreeDir, remoteRef];
      } else {
        // Brand-new branch from base
        gitArgs = [
          "worktree", "add", "-b", branchName,
          worktreeDir,
          fromBranch!,
        ];
      }

      // ── Create worktree ────────────────────────────────────────────
      const result = await pi.exec("git", gitArgs);
      if (result.code !== 0) {
        const errMsg = result.stderr.trim() || result.stdout.trim();
        ctx.ui.notify(`Failed to create worktree: ${errMsg}`, "error");
        return;
      }

      // ── Persist state ──────────────────────────────────────────────
      currentWorktree = {
        path: worktreeDir,
        branch: branchName,
        originalCwd: cwd,
      };
      await pi.appendEntry(WORKTREE_CUSTOM_TYPE, currentWorktree);

      ctx.ui.setStatus("worktree", `🌿 ${branchName}`);
      ctx.ui.notify(`Worktree created: ${worktreeDir}`, "info");

      pi.sendMessage({
        customType: "worktree",
        content:
          `Now working in worktree directory: ${worktreeDir}\n` +
          `Branch: ${branchName}\n` +
          `All tool calls (bash, read, write, edit, ls, find, grep) operate relative to this directory.\n` +
          `Use /unbranch to return to the original directory (${cwd}).`,
        display: true,
      });
    },
  });

  // -----------------------------------------------------------------------
  // Command: /unbranch — return to original directory
  // -----------------------------------------------------------------------
  pi.registerCommand("unbranch", {
    description: "Return to the original working directory",
    handler: async (_args, ctx) => {
      if (!currentWorktree) {
        ctx.ui.notify("No active worktree", "info");
        return;
      }

      const original = currentWorktree.originalCwd;
      currentWorktree = null;

      // Append a "cleared" marker so resuming this session won't
      // re-activate the worktree.
      await pi.appendEntry(WORKTREE_CUSTOM_TYPE, { cleared: true } as WorktreeEntry);

      ctx.ui.setStatus("worktree", undefined);
      ctx.ui.notify(`Returned to: ${original}`, "info");

      pi.sendMessage({
        customType: "worktree",
        content: `Returned to original working directory: ${original}. All tool calls now operate here.`,
        display: true,
      });
    },
  });
}
