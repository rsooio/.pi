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
// Path rewriting
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace `fromCwd/...` with `toCwd/...`, skipping paths already under `.worktree/`. */
function rewritePathPrefix(s: string, fromCwd: string, toCwd: string): string {
  const escaped = escapeRegex(fromCwd);
  return s.replace(new RegExp(`${escaped}/(?!\\.worktree/)`, "g"), `${toCwd}/`);
}

/** JSON-roundtrip an entry, rewriting all string values with the given prefix mapping. */
function rewriteEntryPaths<T>(entry: T, fromCwd: string, toCwd: string): T {
  return JSON.parse(rewritePathPrefix(JSON.stringify(entry), fromCwd, toCwd)) as T;
}

/** Derive `{ from, to }` from a worktree cwd.  Returns null for non-worktree dirs. */
function worktreeRewrite(cwd: string): { from: string; to: string } | null {
  const idx = cwd.indexOf("/.worktree/");
  if (idx === -1) return null;
  return { from: cwd.slice(0, idx), to: cwd };
}

/** Rewrite path / file_path / edits[].oldText / edits[].newText in place. */
function rewriteToolInput(input: Record<string, unknown>, from: string, to: string): void {
  for (const key of ["path", "file_path"]) {
    const val = input[key];
    if (typeof val === "string") input[key] = rewritePathPrefix(val, from, to);
  }
  const edits = input["edits"];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") {
        for (const ek of ["oldText", "newText"]) {
          const ev = (edit as Record<string, unknown>)[ek];
          if (typeof ev === "string") (edit as Record<string, unknown>)[ek] = rewritePathPrefix(ev, from, to);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstUserText(
  entries: { type: string; message?: { role: string; content: unknown } }[],
): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type: string }).type === "text" &&
        typeof (part as { text: string }).text === "string"
      ) {
        const text = (part as { text: string }).text.trim();
        if (text) return text;
      }
    }
  }
  return undefined;
}

async function ensureGitRepo(pi: ExtensionAPI): Promise<boolean> {
  const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
  return code === 0;
}

async function listBranches(pi: ExtensionAPI): Promise<string[]> {
  const [localOut, allOut] = await Promise.all([
    pi.exec("git", ["branch", "--format=%(refname:short)"]),
    pi.exec("git", ["branch", "-a", "--format=%(refname:short)"]),
  ]);

  const localNames = new Set(
    localOut.stdout.trim().split("\n").filter(Boolean),
  );

  const lines = allOut.stdout.trim().split("\n").filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    if (line.includes("->") || line.endsWith("/HEAD")) continue;
    const name = line.replace(/^(remotes|heads)\//, "");
    if (seen.has(name)) continue;
    if (!name.includes("/") && !localNames.has(name)) continue;
    if (name.includes("/")) {
      const short = name.slice(name.indexOf("/") + 1);
      if (localNames.has(short)) continue;
    }
    seen.add(name);
    result.push(name);
  }

  return result.sort((a, b) => {
    const aR = a.includes("/") ? 1 : 0;
    const bR = b.includes("/") ? 1 : 0;
    if (aR !== bR) return aR - bR;
    return a.localeCompare(b);
  });
}

async function localBranchExists(branch: string, pi: ExtensionAPI): Promise<boolean> {
  const { code } = await pi.exec("git", [
    "show-ref", "--verify", "--quiet", `refs/heads/${branch}`,
  ]);
  return code === 0;
}

async function findRemoteRef(branch: string, pi: ExtensionAPI): Promise<string | null> {
  const { stdout } = await pi.exec("git", [
    "branch", "-r", "--format=%(refname:short)",
  ]);
  for (const ref of stdout.trim().split("\n").filter(Boolean)) {
    if (ref === branch || ref.endsWith(`/${branch}`)) return ref;
  }
  return null;
}

function freshId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Correct absolute paths that the LLM occasionally points at the original
  // project directory instead of the worktree.  The rewrite pair is derived
  // from ctx.cwd at call time so the fix works across pi restarts.
  pi.on("tool_call", (event, ctx) => {
    const rw = worktreeRewrite(ctx.cwd);
    if (!rw || !("input" in event)) return;
    rewriteToolInput(event.input as Record<string, unknown>, rw.from, rw.to);
  });

  pi.registerCommand("branch", {
    description: "Switch to or create a git branch with worktree",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;

      if (!(await ensureGitRepo(pi))) {
        ctx.ui.notify("Not a git repository (or no git installed)", "error");
        return;
      }

      // Parse args
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

      // Resolve remote branch names to local short names
      const slashIdx = branchName.indexOf("/");
      if (slashIdx > 0 && !(await localBranchExists(branchName, pi))) {
        const remote = await findRemoteRef(branchName, pi);
        if (remote) branchName = branchName.slice(slashIdx + 1);
      }

      // Resolve branch
      const existsLocally = await localBranchExists(branchName, pi);
      const remoteRef = !existsLocally ? await findRemoteRef(branchName, pi) : null;
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
        const sorted = def ? [def, ...branches.filter((b) => b !== def)] : branches;
        fromBranch = await ctx.ui.select(
          `Branch '${branchName}' not found — create from which branch?`,
          sorted,
        );
        if (!fromBranch) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
      }

      // Create worktree on disk
      const worktreeDir = path.resolve(cwd, ".worktree", branchName);

      if (!existsSync(worktreeDir)) {
        let gitArgs: string[];
        if (existsLocally) {
          gitArgs = ["worktree", "add", worktreeDir, branchName];
        } else if (remoteRef) {
          gitArgs = ["worktree", "add", "-b", branchName, worktreeDir, remoteRef];
        } else {
          gitArgs = ["worktree", "add", "-b", branchName, worktreeDir, fromBranch!];
        }
        const result = await pi.exec("git", gitArgs);
        if (result.code !== 0) {
          const msg = result.stderr.trim() || result.stdout.trim();
          ctx.ui.notify(`Failed to create worktree: ${msg}`, "error");
          return;
        }
      }

      // Clone history into a new session file
      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const branchEntries = ctx.sessionManager.getBranch();

      const userText = firstUserText(branchEntries);
      const sessionName = userText
        ? `(${branchName}) · "${userText.slice(0, 50)}${userText.length > 50 ? "..." : ""}"`
        : `(${branchName})`;

      // Remap entry IDs and rewrite any absolute paths pointing to the
      // original project so the LLM does not reuse stale paths from history.
      const idMap = new Map<string, string>();
      const entries = branchEntries.map((entry) => {
        const newId = freshId();
        idMap.set(entry.id, newId);
        return { ...rewriteEntryPaths(entry, cwd, worktreeDir), id: newId };
      });

      for (const entry of entries) {
        if (entry.parentId && idMap.has(entry.parentId)) {
          entry.parentId = idMap.get(entry.parentId)!;
        }
      }

      const leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
      const sessionInfoEntry = {
        type: "session_info",
        id: freshId(),
        parentId: leafId,
        timestamp: new Date().toISOString(),
        name: sessionName,
      };

      const newId = freshId();
      const timestamp = new Date().toISOString();
      const fileTs = timestamp.replace(/[:.]/g, "-");
      const sessionDir = ctx.sessionManager.getSessionDir();
      const newFile = path.join(sessionDir, `${fileTs}_${newId}.jsonl`);

      const header = {
        type: "session" as const,
        version: 3,
        id: newId,
        timestamp,
        cwd: worktreeDir,
        ...(currentSessionFile ? { parentSession: currentSessionFile } : {}),
      };

      const lines = [header, ...entries, sessionInfoEntry].map((e) => JSON.stringify(e));
      writeFileSync(newFile, lines.join("\n") + "\n");

      // Switch to the new session — runtime is rebuilt with the worktree as cwd.
      // After this call the current ctx is stale; do NOT use it.
      await ctx.switchSession(newFile, {
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Worktree: ${worktreeDir}`, "info");
        },
      });
    },
  });
}
