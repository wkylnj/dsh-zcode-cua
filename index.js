/**
 * Host half of the per-session Computer Use switch.
 *
 * The MCP server that actually drives the desktop lives in `server/index.js`
 * and is spawned by `@deepseek-ai/dsh-mcp-client`, not by this file. This entry
 * is the Harness plugin that decides whether that tool may run at all: it
 * registers a tool guard (deny unless the session opted in) and two small HTTP
 * routes the composer switch uses to read and write that state.
 *
 * Keeping the gate in a Host plugin rather than inside the MCP server is what
 * makes it a gate rather than advice: the guard runs before the call reaches
 * the child process, so a denied call never starts a helper, never moves the
 * mouse, and never spends a screenshot.
 *
 * @module dsh-zcode-cua
 */

import { clearGrants, guardBody, isGranted, setGranted } from "./server/access.js";

/** Route the composer switch reads and writes. */
const ACCESS_PATH = "/plugins/dsh-zcode-cua/access";

/**
 * Services this plugin needs.
 *
 * `tools` must be declared here, not merely used: Cordis refuses to read
 * `ctx.tools` on an undeclared service (`cannot get property "tools" without
 * inject`), which fails the whole plugin row rather than one call.
 *
 * `webServer` and `connection` are declared here rather than at the injection
 * site below for a reason that outranks convenience: the access route WRITES
 * the grant. Without the connection fence, any page the user has open in a
 * browser could `POST` this route and switch computer control on for a session,
 * which is a remote page acquiring the ability to move the mouse. A gate whose
 * only weakness is that anyone can open it is not a gate, so a Host that cannot
 * supply the fence does not get the route at all — the switch disappears and the
 * guard stays. That is why these two are hard requirements instead of optional
 * injections.
 */
export const inject = ["tools", "webServer", "connection"];

/**
 * Answer one access request.
 *
 * The session id comes from the caller, never from server-side guesswork: the
 * Harness webserver serves every session on one origin, so there is no
 * request-scoped session to read. The switch already holds its `sessionId`
 * prop, which makes the client the only party that knows which session the
 * user is looking at.
 *
 * `GET  ?session=<id>` answers `{ granted }`.
 * `POST ?session=<id>` with `{ granted: boolean }` sets it and answers the same.
 *
 * A missing session id is a 400 rather than a silent `{ granted: false }`:
 * "this request forgot to name a session" and "this session is off" must not
 * look alike, or a broken switch reads as a working one.
 */
async function handleAccess(req, res, logger, connection) {
  /**
   * The trust fence, and it must run before anything else reads the request.
   *
   * `connection.requestRejection(req)` answers `401`/`403` for a request that
   * fails the Host/Origin check (DNS rebinding, a foreign page's cross-site
   * call) or that carries no browser authentication, and `undefined` for one
   * that may proceed. Calling it first is what stops a web page the user has
   * open from flipping this switch: that page shares the browser but not the
   * credential, and its Origin is not this Host.
   *
   * This route is a WRITE route for a capability that moves the mouse, so the
   * fence is not optional here. If the service ever answers something other
   * than the three documented values, the request is refused: a fence that
   * fails open is worse than no fence, because the code reads as protected.
   */
  const rejection = requestRejectionOf(connection, req);
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.setHeader("cache-control", "no-store");
    res.end();
    return;
  }
  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    writeJson(res, 400, { error: "malformed request url" });
    return;
  }
  const sessionId = (url.searchParams.get("session") ?? "").trim();
  if (sessionId === "") {
    writeJson(res, 400, { error: "missing session" });
    return;
  }
  if (req.method === "GET") {
    writeJson(res, 200, { granted: isGranted(sessionId) });
    return;
  }
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method not allowed" });
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    writeJson(res, 400, { error: `unreadable body: ${messageOf(error)}` });
    return;
  }
  if (typeof body?.granted !== "boolean") {
    writeJson(res, 400, { error: "body must carry a boolean granted" });
    return;
  }
  setGranted(sessionId, body.granted);
  logger?.debug?.(`dsh-zcode-cua: computer control ${body.granted ? "on" : "off"} for ${sessionId}`);
  writeJson(res, 200, { granted: isGranted(sessionId) });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `401`/`403` when the request fails the Host/Origin fence or carries no
 * browser credential, `undefined` when it may proceed.
 *
 * The service is passed in rather than read from a module-level binding: a
 * module-level variable would be shared by every `apply` in the process, so a
 * second mount (a test, a reload that overlaps the previous generation) would
 * silently fence its requests with the other instance's service.
 *
 * Deliberately total: a service that is missing, a method that throws, or a
 * value outside the documented three all resolve to `403`. The alternative —
 * letting an unexpected shape fall through as "no rejection" — would turn a
 * broken fence into an open one, and the failure would be invisible because the
 * code still reads as guarded.
 */
function requestRejectionOf(connection, req) {
  if (connection === undefined || connection === null) return 403;
  if (typeof connection.requestRejection !== "function") return 403;
  let rejection;
  try {
    rejection = connection.requestRejection(req);
  } catch {
    return 403;
  }
  if (rejection === undefined) return undefined;
  return rejection === 401 || rejection === 403 ? rejection : 403;
}

function writeJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read and parse a small JSON request body, bounded so a stuck upload cannot hang the route. */
function readJson(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Mount the gate.
 *
 * `ctx.tools.guard` is scoped to the plugin that registers it and is monotonic
 * while mounted, which is the property a capability gate needs: no later
 * registration can lift it. The disposer removes it on unload, and the grants
 * are cleared at the same time so a re-mounted plugin does not inherit
 * authority granted to the previous generation.
 */
export function apply(ctx, _config) {
  const connection = Reflect.get(ctx, "connection");

  ctx.effect(() => {
    const removeGuard = ctx.tools.guard(guardBody);
    return () => {
      removeGuard();
      clearGrants();
    };
  });

  // No `ctx.inject` wrapper here: `webServer` and `connection` are hard
  // requirements declared in `inject`, so by the time `apply` runs both exist.
  // Registering the route unconditionally is the point — a Host that could not
  // supply the connection fence would never reach this line, rather than
  // silently serving an unfenced write route.
  //
  // `connection` is captured per mount, not held in a module variable: two
  // mounts in one process (a test, an overlapping reload) must each fence with
  // their own service.
  const dispose = ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: ACCESS_PATH,
      handler: (req, res) => handleAccess(req, res, ctx.logger, connection),
    }),
  );
  return dispose;
}
