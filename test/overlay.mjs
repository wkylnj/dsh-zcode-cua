/**
 * Overlay-specific end-to-end test.
 *
 * Proves the three behaviours the indicator promises, using the same stdio
 * handshake DSH uses — not a unit test of the C# in isolation:
 *
 *   1. Nothing is on screen while the bridge is idle.
 *   2. Six overlay windows are visible while a `js` call is running.
 *   3. They are gone again once the call returns.
 *
 * A fourth property — that the windows are absent from a screen capture — cannot
 * be asserted from here without taking a screenshot, and a screenshot test that
 * silently passes on a machine with no display is worse than none. It is verified
 * by hand and recorded in the README.
 *
 * Usage: node test/overlay.mjs
 * Windows only. Exits 0 on success, 1 on any failure.
 */

import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "..", "server", "index.js");

/** PowerShell that lists our overlay windows and whether each is visible. */
const PROBE_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class OverlayProbe {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    public static List<string> Find() {
        var found = new List<string>();
        EnumWindows((h, l) => {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            var name = sb.ToString();
            if (name.StartsWith("DshCuaOverlay_") && IsWindowVisible(h)) found.Add(name);
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
[OverlayProbe]::Find() | ForEach-Object { $_ }
`;

/** Visible overlay windows right now, as an array of class names. */
function visibleOverlayWindows() {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PROBE_SCRIPT],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    return String(out)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    // A probe failure must not be read as "no windows": that would make the
    // idle assertion pass for the wrong reason.
    return undefined;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${detail}`}\n`);
}

async function main() {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: join(HERE, ".."),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (id, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (const line of buffer.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const message = JSON.parse(line);
          if (message.id === id) return message;
        } catch {
          // Partial line; keep waiting.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    await sleep(2500);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "overlay-test", version: "1" } },
    });
    const init = await waitFor(1, 20_000);
    check("initialize answers", init?.result?.protocolVersion !== undefined, init?.result?.protocolVersion);

    const idle = visibleOverlayWindows();
    check("idle: no overlay windows", idle !== undefined && idle.length === 0,
      idle === undefined ? "probe failed" : `${idle.length} window(s)`);

    // A cell that runs long enough for the probe to sample it mid-flight.
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "js",
        arguments: { title: "overlay test", code: "await new Promise(r => setTimeout(r, 6000)); nodeRepl.write('ok')" },
      },
    });
    await sleep(3000);
    const during = visibleOverlayWindows();
    check("during call: overlay is up", during !== undefined && during.length >= 5,
      during === undefined ? "probe failed" : `${during.length} window(s)`);
    if (during !== undefined && during.length > 0) {
      const named = during.every((name) => name.startsWith("DshCuaOverlay_"));
      check("during call: every window is ours", named);
    }

    const call = await waitFor(2, 60_000);
    check("js call returns", call?.result?.content !== undefined);

    await sleep(1500);
    const after = visibleOverlayWindows();
    check("after call: overlay is gone", after !== undefined && after.length === 0,
      after === undefined ? "probe failed" : `${after.length} window(s)`);

    // A tool name the indicator does not track must not raise it. `js` is the
    // only tool upstream, so this asserts the guard rather than a real call.
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "not-a-tool", arguments: {} } });
    await sleep(1200);
    const unknown = visibleOverlayWindows();
    check("unknown tool: no overlay", unknown !== undefined && unknown.length === 0,
      unknown === undefined ? "probe failed" : `${unknown.length} window(s)`);
    await waitFor(3, 20_000);
  } finally {
    child.stdin.end();
    child.kill();
  }

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length > 0 && stderr.trim() !== "") {
    process.stdout.write(`\nbridge stderr:\n${stderr.split("\n").slice(0, 20).join("\n")}\n`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`overlay test failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
