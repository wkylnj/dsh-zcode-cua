/**
 * Unit tests for the per-session access gate.
 *
 * These cover the decisions the guard is supposed to encode, not the plumbing:
 * a denial for the tool it owns, an allow for every other tool, an allow only
 * for a session that opted in, and a denial when there is no session to match
 * against. The last one is the case that is easy to get wrong in the permissive
 * direction — "no agent attached" must not read as "the user said yes".
 *
 * Run: node test/access.mjs
 */

import { clearGrants, guardBody, isGranted, setGranted, CUA_TOOL_NAME } from "../server/access.js";

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}`);
}

function exec(name, sessionId) {
  return sessionId === undefined ? { name } : { name, agent: { id: sessionId } };
}

clearGrants();

// A fresh session is denied.
check("default: the tool is denied", guardBody(exec(CUA_TOOL_NAME, "sess-a")) !== undefined);

// Every other tool passes, granted or not: a guard that denies foreign tools
// would silently break unrelated plugins.
check("other tools pass while denied", guardBody(exec("pwsh", "sess-a")) === undefined);
check("other tools pass while granted", guardBody(exec("read", "sess-a")) === undefined);

// A grant is per session.
setGranted("sess-a", true);
check("granted session passes", guardBody(exec(CUA_TOOL_NAME, "sess-a")) === undefined);
check("grant is not shared", guardBody(exec(CUA_TOOL_NAME, "sess-b")) !== undefined);
check("isGranted agrees", isGranted("sess-a") === true && isGranted("sess-b") === false);

// No session attached cannot match a grant, so it is denied even while some
// other session is on.
check("no agent is denied", guardBody(exec(CUA_TOOL_NAME, undefined)) !== undefined);
check("empty agent id is denied", guardBody({ name: CUA_TOOL_NAME, agent: { id: "" } }) !== undefined);

// Revoking works, and the denial carries a code the model can act on.
setGranted("sess-a", false);
const denial = guardBody(exec(CUA_TOOL_NAME, "sess-a"));
check("revoked session is denied", denial !== undefined);
check("denial carries a code", denial?.info?.code === "COMPUTER_USE_DISABLED");
check("denial names the switch", typeof denial?.reason === "string" && denial.reason.includes("toggle"));

// Clearing drops everything, which is what plugin unload does.
setGranted("sess-a", true);
setGranted("sess-b", true);
clearGrants();
check("clearGrants drops all", isGranted("sess-a") === false && isGranted("sess-b") === false);

// A junk session id must not create a grant (a Set would happily store "").
setGranted("", true);
check("empty id does not grant", isGranted("") === false);

console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
