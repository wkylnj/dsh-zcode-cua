/**
 * Tests for the access route's connection fence.
 *
 * The route WRITES the computer-control grant, so an unfenced route is not a
 * cosmetic defect: any page the user has open in a browser could POST it and
 * hand itself the ability to move the mouse. These tests pin the three things
 * that make the fence trustworthy — it refuses an unauthenticated caller, it
 * lets an authenticated one through, and every unexpected shape (missing
 * service, throwing service, undocumented return value) fails CLOSED.
 *
 * The last property is the one worth testing hardest. A fence that fails open
 * still reads as guarded, so the defect is invisible until someone abuses it.
 *
 * Run: node test/fence.mjs
 */

import { pathToFileURL } from "node:url";

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}`);
}

/**
 * Load the Host entry with a stub `connection` service.
 *
 * `index.js` reads the service through `Reflect.get(ctx, "connection")` at
 * apply time, so a plain object is enough — no Cordis runtime needed. The route
 * handler is captured by the stub webserver and called directly, which is the
 * only part of the request path that carries the fence.
 */
async function mountWith(connection) {
  // Import by file URL rather than a path: `new URL(..., import.meta.url)`
  // already yields one, and on Windows converting it to a path and back is
  // what produces `D:\D:\...` or a bare `d:` scheme.
  const mod = await import(new URL("../index.js", import.meta.url).href);

  let handler;
  const disposers = [];
  const ctx = {
    logger: { debug() {}, warn() {}, error() {} },
    connection,
    tools: {
      guard() {
        return () => {};
      },
    },
    webServer: {
      register(entry) {
        handler = entry.handler;
        return () => {};
      },
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return () => {};
    },
  };
  mod.apply(ctx, {});
  return {
    call: (request, res) => handler(request, res),
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

/** Minimal `ServerResponse` that records what the route did. */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers ?? {})) {
        this.headers[name.toLowerCase()] = value;
      }
      return this;
    },
    end(text) {
      if (typeof text === "string") this.body += text;
      this.ended = true;
      return this;
    },
  };
}

function req(method, url, body) {
  const listeners = new Map();
  const stream = {
    method,
    url,
    headers: { host: "127.0.0.1:1234", origin: "http://127.0.0.1:1234" },
    on(event, fn) {
      listeners.set(event, fn);
      return stream;
    },
    destroy() {},
  };
  // Feed the body on the next tick, the way a real request arrives.
  queueMicrotask(() => {
    if (body !== undefined) listeners.get("data")?.(Buffer.from(body, "utf8"));
    listeners.get("end")?.();
  });
  return stream;
}

// ── A refused request never reaches the switch ──────────────────────────────

{
  const mounted = await mountWith({ requestRejection: () => 403 });
  const res = makeRes();
  await mounted.call(req("POST", "/plugins/dsh-zcode-cua/access?session=sess-x", '{"granted":true}'), res);
  check("fence 403: status is 403", res.statusCode === 403);
  check("fence 403: body is empty", res.body === "");
  check("fence 403: marked no-store", res.headers["cache-control"] === "no-store");
  mounted.dispose();
}

{
  const mounted = await mountWith({ requestRejection: () => 401 });
  const res = makeRes();
  await mounted.call(req("POST", "/plugins/dsh-zcode-cua/access?session=sess-y", '{"granted":true}'), res);
  check("fence 401: status is 401", res.statusCode === 401);
  mounted.dispose();
}

// A GET is fenced too: reading the switch tells a page which sessions are armed.
{
  const mounted = await mountWith({ requestRejection: () => 403 });
  const res = makeRes();
  await mounted.call(req("GET", "/plugins/dsh-zcode-cua/access?session=sess-z"), res);
  check("fence applies to GET as well", res.statusCode === 403);
  mounted.dispose();
}

// ── An allowed request proceeds ─────────────────────────────────────────────

{
  const mounted = await mountWith({ requestRejection: () => undefined });
  const granted = makeRes();
  await mounted.call(req("POST", "/plugins/dsh-zcode-cua/access?session=sess-ok", '{"granted":true}'), granted);
  check("fence allows: POST answers 200", granted.statusCode === 200);
  check("fence allows: grant was written", JSON.parse(granted.body).granted === true);

  const read = makeRes();
  await mounted.call(req("GET", "/plugins/dsh-zcode-cua/access?session=sess-ok"), read);
  check("fence allows: GET reads it back", JSON.parse(read.body).granted === true);

  // Order matters: when the fence refuses AND the request is also invalid
  // (no session), the answer must be 403, not 400. A 400 would confirm the
  // route exists to a caller that has no business knowing.
  const deniedAndInvalid = makeRes();
  const deniedMounted = await mountWith({ requestRejection: () => 403 });
  await deniedMounted.call(req("GET", "/plugins/dsh-zcode-cua/access"), deniedAndInvalid);
  check("fence runs before validation: 403 wins over 400", deniedAndInvalid.statusCode === 403);
  deniedMounted.dispose();

  // And when the fence allows, the same malformed request does reach validation.
  const allowedAndInvalid = makeRes();
  await mounted.call(req("GET", "/plugins/dsh-zcode-cua/access"), allowedAndInvalid);
  check("fence allows: missing session then answers 400", allowedAndInvalid.statusCode === 400);
  mounted.dispose();
}

// ── Every unexpected shape fails closed ────────────────────────────────────

{
  const mounted = await mountWith(undefined);
  const res = makeRes();
  await mounted.call(req("POST", "/plugins/dsh-zcode-cua/access?session=sess-n", '{"granted":true}'), res);
  check("no connection service: 403", res.statusCode === 403);
  mounted.dispose();
}

{
  const mounted = await mountWith({});
  const res = makeRes();
  await mounted.call(req("POST", "/plugins/dsh-zcode-cua/access?session=sess-m", '{"granted":true}'), res);
  check("service without requestRejection: 403", res.statusCode === 403);
  mounted.dispose();
}

{
  const mounted = await mountWith({
    requestRejection() {
      throw new Error("boom");
    },
  });
  const res = makeRes();
  await mounted.call(req("POST", "/plugins/dsh-zcode-cua/access?session=sess-e", '{"granted":true}'), res);
  check("throwing service: 403", res.statusCode === 403);
  mounted.dispose();
}

{
  // An undocumented return value must not read as "allowed".
  const mounted = await mountWith({ requestRejection: () => 200 });
  const res = makeRes();
  await mounted.call(req("POST", "/plugins/dsh-zcode-cua/access?session=sess-u", '{"granted":true}'), res);
  check("undocumented return value: 403", res.statusCode === 403);
  mounted.dispose();
}

{
  const mounted = await mountWith({ requestRejection: () => null });
  const res = makeRes();
  await mounted.call(req("POST", "/plugins/dsh-zcode-cua/access?session=sess-v", '{"granted":true}'), res);
  check("null return value: 403", res.statusCode === 403);
  mounted.dispose();
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
