/**
 * Helper launcher: starts the ZCode native helper without its ghost cursor.
 *
 * Why this file exists
 * --------------------
 * The upstream `node-repl-host` starts the native helper itself, from the recipe
 * this bridge hands it, and it appends `--ghost-cursor-overlay` unconditionally
 * (`server.js:121868` — no setting, no env var, no way to say no). The helper
 * then paints its own always-on pointer overlay on top of every screen.
 *
 * That overlay was useful while this plugin had no indicator of its own. It no
 * longer is: `server/overlay.js` draws a banner, an edge glow and a cursor ring
 * that Windows excludes from every screenshot, while the ZCode overlay is a
 * plain top-level window that any full-screen capture picks up. Two indicators
 * disagreeing about what is happening is worse than one.
 *
 * The recipe's `command` and `entryPath` are ours to choose, so the entry the
 * upstream launches is this file, which drops the flag and then execs the real
 * helper. Nothing upstream is modified, and `DSH_ZCODE_CUA_KEEP_GHOST_CURSOR=1`
 * restores the stock behaviour.
 *
 * Argument layout received from the upstream:
 *   <this file> --socket <pipe> --parent-pid <pid> --ghost-cursor-overlay
 */

import { spawn } from "node:child_process";

/** Env var the recipe uses to tell us which helper entry to actually run. */
const HELPER_ENTRY_ENV = "DSH_ZCODE_CUA_HELPER_ENTRY";

/** Opt back into the stock ghost cursor. */
const KEEP_ENV = "DSH_ZCODE_CUA_KEEP_GHOST_CURSOR";

const GHOST_FLAG = "--ghost-cursor-overlay";

const entry = process.env[HELPER_ENTRY_ENV]?.trim();
if (!entry) {
  process.stderr.write(`[dsh-zcode-cua] ${HELPER_ENTRY_ENV} is not set; cannot locate the helper entry\n`);
  process.exit(1);
}

const keepGhost = process.env[KEEP_ENV] === "1";
const forwarded = process.argv.slice(2).filter((arg) => keepGhost || arg !== GHOST_FLAG);

// The helper needs the native addon path, which the upstream already put in our
// environment (`ZCODE_CUA_HELPER_ADDON`), and `ELECTRON_RUN_AS_NODE=1`, which it
// also set. Both are inherited, so the child is launched with `process.env`.
const child = spawn(process.execPath, [entry, ...forwarded], {
  cwd: process.env.ZCODE_CUA_HELPER_ROOT?.trim() || process.cwd(),
  env: process.env,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});

child.on("error", (error) => {
  process.stderr.write(`[dsh-zcode-cua] helper launch failed: ${error.message}\n`);
  process.exit(1);
});

// Detach and leave: the upstream does not wait on this process, and the helper
// must outlive it.
child.unref();
process.exit(0);
