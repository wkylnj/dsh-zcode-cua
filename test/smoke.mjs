/**
 * End-to-end smoke test for the MCP proxy.
 *
 * Speaks the legacy handshake DSH uses, then drives one real Computer Use call
 * through the same path the model takes. Prints PASS/FAIL per step so a
 * regression names the step instead of just exiting non-zero.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const ENTRY = join(import.meta.dirname, "..", "server", "index.js");
const child = spawn(process.execPath, [ENTRY], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let buffer = "";
const pending = new Map();
let nextId = 1;
const stderrLines = [];

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    if (line.trim()) stderrLines.push(line);
  }
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    entry(message);
  }
});

function request(method, params, timeoutMs = 180_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" },
  });
  check("initialize answers", init.result?.serverInfo?.name === "zcode-cua", init.result?.protocolVersion ?? "");

  const list = await request("tools/list", {});
  const tools = list.result?.tools ?? [];
  check("tools/list exposes js", tools.some((tool) => tool.name === "js"), `${tools.length} tool(s)`);

  const bootstrap = [
    'const root = process.env.ZCODE_CUA_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT;',
    'const { join } = await import("node:path");',
    'const { pathToFileURL } = await import("node:url");',
    'const { setupComputerUseRuntime } = await import(pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href);',
    "await setupComputerUseRuntime({ globals: globalThis });",
    "const apps = await agent.computerUse.listApps({ emit: false });",
    'nodeRepl.write("APPS=" + apps.length);',
  ].join("\n");

  const call = await request(
    "tools/call",
    { name: "js", arguments: { code: bootstrap, title: "smoke test", timeout_ms: 60_000 } },
    180_000,
  );
  const text = textOf(call.result);
  const match = /APPS=(\d+)/.exec(text);
  check(
    "js call reaches Computer Use",
    call.result?.isError !== true && match !== null,
    match ? `${match[1]} app(s)` : text.slice(0, 160),
  );

  // A cancelled notification must reach the upstream. There is no reply to wait
  // for, so the check is that writing it neither throws nor kills the child.
  notify("notifications/cancelled", { requestId: 999, reason: "smoke" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  check("survives a cancellation notification", child.exitCode === null);

  const ping = await request("ping", {});
  check("still answering after the call", ping.result !== undefined);
} catch (error) {
  check("no exception", false, String(error?.message ?? error));
} finally {
  child.stdin.end();
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (child.exitCode === null) child.kill();
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0 && stderrLines.length > 0) {
    console.log("--- server stderr ---");
    console.log(stderrLines.slice(-20).join("\n"));
  }
  process.exit(failed.length === 0 ? 0 : 1);
}
