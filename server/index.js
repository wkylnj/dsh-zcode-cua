/**
 * MCP server entry point.
 *
 * This is a thin, opinionated proxy in front of ZCode's own
 * `node-repl-host` MCP server. The upstream owns the `js` tool and the whole
 * Computer Use surface; this process exists for two reasons only:
 *
 *   1. It spawns the upstream with the four environment variables that switch
 *      Computer Use on. Without `ZCODE_CUA_PERMISSION_BROKER_SOCKET` and
 *      `ZCODE_CUA_WIN_HELPER_RECIPE` the upstream answers `tools/list` with a
 *      `js` tool that can never reach a desktop, and the failure is invisible
 *      from the model's side.
 *
 *   2. It supplies the request context the upstream validates on every
 *      `tools/call`.
 *
 * The upstream reads that context from `_meta["com.zcode/request-context"]` and
 * rejects a call whose `session_id` or `turn_id` is empty, so this server mints
 * a session id once and a turn id per call.
 *
 * @module dsh-zcode-cua/server
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveRuntime, describeRuntime, runtimeIsComplete } from "./paths.js";

const KEY_PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const KEY_CAPS = "io.modelcontextprotocol/clientCapabilities";
const KEY_INFO = "io.modelcontextprotocol/clientInfo";
const KEY_REQ_CTX = "com.zcode/request-context";
const MODERN_REVISION = "2026-07-28";
const SERVER_NAME = "zcode-cua";
const SERVER_VERSION = "1.0.0";

/** Result fields only modern MCP clients understand. */
const MODERN_ONLY_FIELDS = ["resultType", "ttlMs", "cacheScope"];

const runtime = resolveRuntime();

/**
 * Stable identifiers for this process.
 *
 * `sessionId` groups every action of one DSH session under one identity; it is
 * derived once so reconnects stay consistent. `turnId` must be fresh per tool
 * call — reusing one would make consecutive actions indistinguishable upstream.
 */
const sessionId = process.env.ZCODE_BRIDGE_SESSION_ID?.trim() || `dsh-${randomUUID()}`;
const workspacePath = process.env.ZCODE_BRIDGE_WORKSPACE?.trim() || process.cwd();
const clientMode = process.env.ZCODE_BRIDGE_CLIENT_MODE?.trim() || "desktop-continuous";

/**
 * Launch the upstream MCP server.
 *
 * The helper recipe tells the upstream how to start the native helper and, via
 * `hostPid`, which process should take it down. Pointing `hostPid` at this
 * process is deliberate: when DSH disposes the MCP client, this process exits,
 * the helper's liveness watchdog sees its parent go, and the helper shuts down
 * instead of being left running in the background.
 */
function spawnUpstream() {
  if (!runtime.upstream) {
    throw new Error(
      "ZCode's node-repl-host MCP server was not found. Install ZCode, or point " +
        "ZCODE_BRIDGE_SERVER at its dist/mcp/server.js.",
    );
  }
  const env = {
    ...process.env,
    // The model's bootstrap imports `computer-use-client.mjs` through this root.
    ...(runtime.cuaPluginRoot ? { ZCODE_CUA_PLUGIN_ROOT: runtime.cuaPluginRoot } : {}),
    ...(runtime.cuaPluginRoot ? { ZCODE_PLUGIN_ROOT: runtime.cuaPluginRoot } : {}),
    // Named pipe the helper listens on. The upstream refuses a path outside the
    // `zcode-cua-helper-*` namespace, so the prefix is not cosmetic.
    ZCODE_CUA_PERMISSION_BROKER_SOCKET:
      process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET?.trim() ||
      `\\\\.\\pipe\\zcode-cua-helper-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    // How to start the native helper. `command` runs the helper's entry with
    // Node; the upstream appends `--socket`, `--parent-pid` and the overlay flag.
    ...(runtime.helperEntry && runtime.helperAddon
      ? {
          ZCODE_CUA_WIN_HELPER_RECIPE: JSON.stringify({
            command: process.execPath,
            entryPath: runtime.helperEntry,
            root: runtime.helperRoot,
            addonPath: runtime.helperAddon,
            commandEnv: {},
            hostPid: process.pid,
          }),
        }
      : {}),
  };
  return spawn(process.execPath, [runtime.upstream], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

let upstream;
try {
  upstream = spawnUpstream();
} catch (error) {
  // A missing upstream is reported and then fatal: this process has no tools of
  // its own, so staying alive would present an empty tool list with no reason.
  process.stderr.write(`[dsh-zcode-cua] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

// ── upstream connection ─────────────────────────────────────────────────────
const pending = new Map();
let nextId = 1;

function upstreamRequest(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    upstream.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

let upstreamBuffer = "";
upstream.stdout.on("data", (chunk) => {
  upstreamBuffer += chunk.toString("utf8");
  let newline;
  while ((newline = upstreamBuffer.indexOf("\n")) >= 0) {
    const line = upstreamBuffer.slice(0, newline);
    upstreamBuffer = upstreamBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    const entry = pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    if (message.error) {
      entry.reject(Object.assign(new Error(message.error.message ?? "upstream error"), { rpcError: message.error }));
    } else {
      entry.resolve(message.result);
    }
  }
});

upstream.stderr.on("data", (chunk) => process.stderr.write(chunk));
upstream.on("close", (code) => {
  process.stderr.write(`[dsh-zcode-cua] upstream exited (code ${code})\n`);
  process.exit(0);
});

// ── client side ─────────────────────────────────────────────────────────────
const INSTRUCTIONS = [
  "ZCode Computer Use, proxied for DeepSeek Harness.",
  "",
  "Every `js` call runs in a fresh Node.js kernel, so the runtime must be",
  "bootstrapped inside each call before anything else:",
  "",
  "  const root = process.env.ZCODE_CUA_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT;",
  '  const { join } = await import("node:path");',
  '  const { pathToFileURL } = await import("node:url");',
  "  const { setupComputerUseRuntime } = await import(",
  '    pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href',
  "  );",
  "  await setupComputerUseRuntime({ globals: globalThis });",
  "",
  "Then drive the desktop through `agent.computerUse`.",
  "",
  "Runtime:",
  describeRuntime(runtime),
].join("\n");

function envelope(extra) {
  const base = {
    [KEY_PROTOCOL]: MODERN_REVISION,
    [KEY_CAPS]: {},
    [KEY_INFO]: { name: "dsh-zcode-cua", version: SERVER_VERSION },
  };
  return extra ? { ...base, ...extra } : base;
}

/**
 * The request context the upstream validates.
 *
 * It rejects a `tools/call` whose `session_id` or `turn_id` is empty, so both
 * are always supplied; the session id is stable for this process and the turn
 * id is fresh per call.
 */
function requestContext(turnId) {
  return {
    session_id: sessionId,
    turn_id: turnId,
    workspace_path: workspacePath,
    workspace_key: workspacePath,
    client_mode: clientMode,
    delivery_kind: clientMode,
  };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toLegacyResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const copy = { ...result };
  for (const key of MODERN_ONLY_FIELDS) delete copy[key];
  return copy;
}

/** Attach a fresh turn id to one tools/call. */
function withRequestContext(method, params) {
  if (method !== "tools/call") return params ?? {};
  const incoming = params?._meta ?? {};
  const context = requestContext(`turn-${randomUUID()}`);
  return {
    ...params,
    _meta: { ...envelope(incoming), [KEY_REQ_CTX]: context },
  };
}

let clientIsModern = false;
let legacyHandshakeSeen = false;

async function forwardModern(message) {
  const { id, method, params } = message;
  const forwarded = method === "tools/call" ? withRequestContext(method, params) : { ...(params ?? {}), _meta: envelope(params?._meta) };
  try {
    write({ jsonrpc: "2.0", id, result: await upstreamRequest(method, forwarded) });
  } catch (error) {
    write({ jsonrpc: "2.0", id, error: error.rpcError ?? { code: -32603, message: String(error?.message ?? error) } });
  }
}

async function handleLegacy(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }

  if (method === "ping") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    try {
      write({ jsonrpc: "2.0", id, result: toLegacyResult(await upstreamRequest("tools/list", { _meta: envelope() })) });
    } catch (error) {
      write({ jsonrpc: "2.0", id, error: error.rpcError ?? { code: -32603, message: String(error?.message ?? error) } });
    }
    return;
  }

  if (method === "tools/call") {
    try {
      const forwarded = withRequestContext(method, params);
      write({ jsonrpc: "2.0", id, result: toLegacyResult(await upstreamRequest("tools/call", forwarded)) });
    } catch (error) {
      write({ jsonrpc: "2.0", id, error: error.rpcError ?? { code: -32603, message: String(error?.message ?? error) } });
    }
    return;
  }

  write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

function handleMessage(message) {
  if (message.id === undefined) return;
  if (!clientIsModern && !legacyHandshakeSeen && message.method !== "initialize") {
    if (message.method === "server/discover" || message.params?._meta?.[KEY_PROTOCOL] !== undefined) {
      clientIsModern = true;
    }
  }
  if (message.method === "initialize") legacyHandshakeSeen = true;
  void (clientIsModern ? forwardModern(message) : handleLegacy(message)).catch((error) => {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
  });
}

let clientBuffer = "";
process.stdin.on("data", (chunk) => {
  clientBuffer += chunk.toString("utf8");
  let newline;
  while ((newline = clientBuffer.indexOf("\n")) >= 0) {
    const line = clientBuffer.slice(0, newline);
    clientBuffer = clientBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handleMessage(message);
  }
});

function shutdown(code = 0) {
  try {
    upstream.kill();
  } catch {
    // The child may already be gone; nothing to do.
  }
  process.exit(code);
}

process.stdin.on("end", () => shutdown(0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0));

process.stderr.write(
  `[dsh-zcode-cua] ready (runtime ${runtimeIsComplete(runtime) ? "complete" : "INCOMPLETE"})\n${describeRuntime(runtime)}\n`,
);
