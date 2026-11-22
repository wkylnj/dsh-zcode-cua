/**
 * Host for the "an AI is driving this computer" indicator.
 *
 * The indicator itself is a Win32 layered window built by `Overlay.cs` and driven
 * by `host.ps1`; this module is the Node side: it owns that child process, turns
 * tool calls into show/hide commands, and guarantees the indicator is gone before
 * any screenshot the model could take.
 *
 * ## Why a resident child process
 *
 * Compiling the C# and creating six windows costs a few hundred milliseconds.
 * That is fine ONCE, and unacceptable per tool call: the indicator has to appear
 * when the call starts and disappear before `capture_app`, both of which happen
 * inside a single turn. So the host is spawned on first use, compiles once, and
 * then answers one JSON line per command.
 *
 * ## Why exclusion needs no cooperation from the capture path
 *
 * The affinity alone is enough: Windows omits the window from every capture,
 * including the GDI/DWM paths the CUA helper uses. That matters because the
 * bridge never sees a `capture_app` request — it is a socket message between the
 * upstream and the helper, not an MCP call — so a hide-before-capture scheme
 * could not be wired up from here even if it were wanted. Verified on this
 * machine: a full-screen capture taken mid-tool-call contains no trace of the
 * overlay, while the same capture with the affinity cleared shows the full
 * artwork.
 *
 * ## Failure policy
 *
 * The indicator is decoration. Every path here degrades to "no indicator" and
 * never blocks, delays or fails a tool call: a missing PowerShell, a compile
 * error, a dead host process — all of it is logged once and ignored. A computer
 * use plugin that stops working because its status badge broke would be a bad
 * trade.
 *
 * @module dsh-zcode-cua/overlay
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute directory holding Overlay.cs and host.ps1. */
const OVERLAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "overlay");

/**
 * Tools whose execution should raise the indicator.
 *
 * Only `js` is exposed by the upstream, and every Computer Use action happens
 * inside one. Listing it explicitly rather than "any tool call" keeps the
 * indicator honest: a future non-desktop tool added upstream must not light up a
 * badge claiming the computer is being driven.
 */
const CUA_TOOL_NAMES = new Set(["js"]);

/** How long a single command may take before the host is considered wedged. */
const COMMAND_TIMEOUT_MS = 4000;

/** Delay before a respawn attempt, so a crash loop cannot spin the CPU. */
const RESPAWN_DELAY_MS = 5000;

/**
 * Resolve the PowerShell executable.
 *
 * `powershell.exe` (5.1) is used rather than `pwsh` on purpose: 5.1 is present on
 * every supported Windows, while PowerShell 7 is an optional install. The C# in
 * Overlay.cs targets .NET Framework 4.x, which is exactly what 5.1 provides.
 */
function powershellPath() {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
}

/**
 * Line-delimited JSON channel to one `host.ps1` process.
 *
 * Commands are serialized by a promise chain rather than queued with ids: the
 * protocol is strictly one command, one reply, in order, and keeping it that way
 * removes any need for correlation. A command that times out resolves as a
 * failure instead of rejecting, so a wedged host cannot produce an unhandled
 * rejection from a fire-and-forget caller.
 */
class OverlayHost {
  constructor(options) {
    this.log = options.log;
    this.child = undefined;
    this.pending = undefined;
    this.buffer = "";
    this.chain = Promise.resolve();
    this.failed = false;
    this.spawnedAt = 0;
  }

  /** Whether the indicator is worth trying at all. */
  get usable() {
    return !this.failed && existsSync(join(OVERLAY_DIR, "host.ps1")) && existsSync(join(OVERLAY_DIR, "Overlay.cs"));
  }

  start() {
    if (this.child !== undefined || this.failed) return;
    const script = join(OVERLAY_DIR, "host.ps1");
    const source = join(OVERLAY_DIR, "Overlay.cs");
    let child;
    try {
      child = spawn(
        powershellPath(),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-SourcePath", source],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
    } catch (error) {
      this.fail(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.child = child;
    this.spawnedAt = Date.now();
    this.buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      // stderr carries compile errors and the one-time "peer identity" notices
      // from the CUA helper; both are worth one line each, not a flood.
      if (text !== "") this.log(`overlay: ${text.split("\n").slice(-3).join(" ")}`);
    });
    child.on("error", (error) => this.fail(`process error: ${error.message}`));
    child.on("exit", (code, signal) => {
      this.child = undefined;
      const reason = signal === null ? `exit ${code}` : `signal ${signal}`;
      if (this.pending !== undefined) {
        const settle = this.pending;
        this.pending = undefined;
        settle({ ok: false, detail: `host exited: ${reason}` });
      }
      // A host that dies within a second of spawning is broken (compile error,
      // missing assembly); retrying it on every tool call would just spam.
      if (Date.now() - this.spawnedAt < 1000) {
        this.fail(`host died immediately (${reason})`);
        return;
      }
      this.log(`overlay: host exited (${reason}); will respawn on next use`);
      // Deliberately not respawning here: the next show() will, and a turn that
      // never asks again should not keep a process alive.
      this.respawnAllowedAt = Date.now() + RESPAWN_DELAY_MS;
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line === "") continue;
      const settle = this.pending;
      if (settle === undefined) continue;
      this.pending = undefined;
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        settle({ ok: false, detail: `unparsable reply: ${line.slice(0, 120)}` });
        continue;
      }
      settle({ ok: reply?.ok === true, detail: typeof reply?.detail === "string" ? reply.detail : "" });
    }
  }

  fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.log(`overlay: disabled — ${reason}`);
  }

  /** Send one command, awaiting its reply. Never throws. */
  command(name, extra) {
    const run = async () => {
      if (!this.usable) return { ok: false, detail: "unavailable" };
      if (this.child === undefined) {
        if (this.respawnAllowedAt !== undefined && Date.now() < this.respawnAllowedAt) {
          return { ok: false, detail: "cooling down" };
        }
        this.start();
        if (this.child === undefined) return { ok: false, detail: "not started" };
        // The first line the host prints is `{"ok":true,"detail":"ready"}`; it
        // arrives as a normal reply, so the first real command simply queues
        // behind it. Nothing to do here.
      }
      return await this.send(name, extra);
    };
    // Chain, so two concurrent tool calls cannot interleave half-lines.
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  send(name, extra) {
    return new Promise((resolve) => {
      const child = this.child;
      if (child === undefined || child.stdin === undefined) {
        resolve({ ok: false, detail: "no host" });
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (this.pending === finish) this.pending = undefined;
        resolve(value);
      };
      this.pending = finish;
      const timer = setTimeout(() => {
        finish({ ok: false, detail: `timeout after ${COMMAND_TIMEOUT_MS}ms` });
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      const wrapped = finish;
      this.pending = (value) => {
        clearTimeout(timer);
        wrapped(value);
      };
      try {
        child.stdin.write(`${JSON.stringify({ cmd: name, ...(extra ?? {}) })}\n`);
      } catch (error) {
        finish({ ok: false, detail: `write failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
  }

  dispose() {
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    try {
      child.stdin.write(`${JSON.stringify({ cmd: "quit" })}\n`);
      child.stdin.end();
    } catch {
      // Already gone.
    }
    // Give it a moment to destroy its windows, then make sure.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }, 500);
    timer.unref?.();
  }
}

/**
 * The indicator as the bridge uses it.
 *
 * Tracks nesting so that two overlapping tool calls do not hide the indicator
 * from under each other: the first call raises it, the last one lowers it.
 */
export function createOverlay(options = {}) {
  const log = options.log ?? ((message) => process.stderr.write(`[dsh-zcode-cua] ${message}\n`));
  const enabled = options.enabled !== false;
  const host = new OverlayHost({ log });
  let depth = 0;
  let shown = false;

  const show = (phase) => {
    if (!enabled) return;
    void host.command("show", { phase }).then((reply) => {
      if (!reply.ok) log(`overlay: show failed — ${reply.detail}`);
    });
  };
  const hide = () => {
    if (!enabled) return;
    void host.command("hide").then((reply) => {
      if (!reply.ok) log(`overlay: hide failed — ${reply.detail}`);
    });
  };

  return {
    /** Whether this tool call should raise the indicator. */
    handlesTool(name) {
      return enabled && CUA_TOOL_NAMES.has(name);
    },

    /** A tool call started. */
    enter() {
      if (!enabled) return;
      depth += 1;
      if (depth === 1 && !shown) {
        shown = true;
        show("working");
      }
    },

    /** A tool call finished, failed or was cancelled. */
    leave() {
      if (!enabled) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 && shown) {
        shown = false;
        hide();
      }
    },

    /** Diagnostic snapshot for the smoke test. */
    async diagnose() {
      if (!enabled) return { ok: true, detail: "disabled" };
      return await host.command("diagnose");
    },

    dispose() {
      host.dispose();
    },
  };
}

export const OVERLAY_CUA_TOOLS = CUA_TOOL_NAMES;
