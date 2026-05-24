/**
 * Dired Extension — /dired command
 *
 * Opens a directory in the current Emacs instance via emacsclient,
 * non-blocking (returns immediately, does not wait for Emacs).
 *
 * Usage:
 *   /dired           → opens cwd in dired
 *   /dired <path>    → opens <path> in dired
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("dired", {
    description: "Open directory in Emacs dired (non-blocking)",
    handler: async (args, ctx) => {
      const dir = args.trim()
        ? resolve(ctx.cwd, args.trim())
        : ctx.cwd;

      const child = spawn("emacsclient", ["-n", dir], {
        detached: true,
        stdio: "ignore",
      });

      child.unref();
      ctx.ui.notify(`Dired: ${dir}`, "info");
    },
  });
}
