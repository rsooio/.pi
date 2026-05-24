/**
 * Worktree Extension — git worktree-based branch management
 *
 *   /branch <name> [from]
 *
 * Clones the active conversation history into a new session file whose
 * header points `cwd` at the worktree directory.  The session file is placed
 * in the original project's session directory so both the original and the
 * worktree session appear under /resume.
 *
 * After the switch, pi runs natively in the worktree — no tool-call
 * interception, no path-rewriting, no hacks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { existsSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureGitRepo(pi: ExtensionAPI): Promise<boolean> {
  const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
  return code === 0;
}

async function listBranches(pi: ExtensionAPI): Promise<string[]> {
  const { stdout } = await pi.exec("git", [
    "branch", "-a", "--format=%(refname:short)",
  ]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (line.includes("->")) continue;
    const cleaned = line.replace(/^remotes\//, "");
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result.sort((a, b) => {
    const aR = a.includes("/") ? 1 : 0;
    const bR = b.includes("/") ? 1 : 0;
    if (aR !== bR) return aR - bR;
    return a.localeCompare(b);
  });
}

async function localBranchExists(
  branch: string,
  pi: ExtensionAPI,
): Promise<boolean> {
  const { code } = await pi.exec("git", [
    "show-ref", "--verify", "--quiet", `refs/heads/${branch}`,
  ]);
  return code === 0;
}

async function findRemoteRef(
  branch: string,
  pi: ExtensionAPI,
): Promise<string | null> {
  const { stdout } = await pi.exec("git", [
    "branch", "-r", "--format=%(refname:short)",
  ]);
  for (const ref of stdout.trim().split("\n").filter(Boolean)) {
    if (ref === branch || ref.endsWith(`/${branch}`)) return ref;
  }
  return null;
}

/** Generate a fresh ID for a cloned entry, remapping old→new. */
function freshId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("branch", {
    description: "Switch to or create a git branch with worktree",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const projectName = path.basename(cwd);

      if (!(await ensureGitRepo(pi))) {
        ctx.ui.notify("Not a git repository (or no git installed)", "error");
        return;
      }

      // ── Parse args ─────────────────────────────────────────────────
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let branchName = parts[0];
      let fromBranch = parts[1];

      if (!branchName) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /branch <name> [from]", "error");
          return;
        }
        const branches = await listBranches(pi);
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

      // ── Resolve branch ─────────────────────────────────────────────
      const existsLocally = await localBranchExists(branchName, pi);
      const remoteRef = !existsLocally
        ? await findRemoteRef(branchName, pi)
        : null;
      const branchExists = existsLocally || remoteRef !== null;

      if (!branchExists && !fromBranch) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `Branch '${branchName}' not found. Specify base: /branch ${branchName} <from>`,
            "error",
          );
          return;
        }
        const branches = await listBranches(pi);
        const def = branches.find((b) => b === "main" || b === "master");
        const sorted = def
          ? [def, ...branches.filter((b) => b !== def)]
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

      // ── Create worktree on disk ────────────────────────────────────
      const worktreeDir = path.resolve(
        cwd, ".pi", "worktree", projectName, branchName,
      );

      if (!existsSync(worktreeDir)) {
        let gitArgs: string[];
        if (existsLocally) {
          gitArgs = ["worktree", "add", worktreeDir, branchName];
        } else if (remoteRef) {
          gitArgs = [
            "worktree", "add", "-b", branchName, worktreeDir, remoteRef,
          ];
        } else {
          gitArgs = [
            "worktree", "add", "-b", branchName, worktreeDir, fromBranch!,
          ];
        }
        const result = await pi.exec("git", gitArgs);
        if (result.code !== 0) {
          const msg = result.stderr.trim() || result.stdout.trim();
          ctx.ui.notify(`Failed to create worktree: ${msg}`, "error");
          return;
        }
      }

      // ── Clone history into a new session file ──────────────────────
      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const branchEntries = ctx.sessionManager.getBranch();

      // Remap entry IDs so the new session has its own identity.
      const idMap = new Map<string, string>();
      const entries = branchEntries.map((entry) => {
        const newId = freshId();
        idMap.set(entry.id, newId);
        return { ...entry, id: newId };
      });

      // Rewire parentId pointers.
      for (const entry of entries) {
        if (entry.parentId && idMap.has(entry.parentId)) {
          entry.parentId = idMap.get(entry.parentId)!;
        }
      }

      const newId = freshId();
      const timestamp = new Date().toISOString();
      const fileTs = timestamp.replace(/[:.]/g, "-");
      const sessionDir = ctx.sessionManager.getSessionDir();
      const newFile = path.join(
        sessionDir, `${fileTs}_${newId}.jsonl`,
      );

      const header = {
        type: "session" as const,
        version: 3,
        id: newId,
        timestamp,
        cwd: worktreeDir,
        ...(currentSessionFile
          ? { parentSession: currentSessionFile }
          : {}),
      };

      const lines = [header, ...entries].map((e) => JSON.stringify(e));
      writeFileSync(newFile, lines.join("\n") + "\n");

      // ── Switch — runtime is rebuilt with the worktree as cwd ───────
      // After this call the current ctx is stale.  Do NOT use it.
      await ctx.switchSession(newFile, {
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Worktree: ${worktreeDir}`, "info");
        },
      });
    },
  });
}
