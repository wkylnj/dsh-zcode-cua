/**
 * Per-session opt-in for the Computer Use tool.
 *
 * ## Why this exists
 *
 * The `js` tool can drive the whole desktop: it clicks, types into whatever
 * holds the keyboard, and reads any window's accessibility tree. That is the
 * point of the plugin, and it is also far too much authority to hand a new
 * session by default — the user starts a session to ask a question and gets an
 * agent that may take the mouse. So the tool is DENIED until the user turns it
 * on for that session, from a switch under the composer.
 *
 * ## Why the state lives here and not in the session log
 *
 * The Harness refuses a stored event whose `type` it does not know unless the
 * envelope carries `ignorable: true`, and live `Session.append()` cannot set
 * that marker. Writing an opt-in record into the log would therefore make the
 * session refuse to reopen after a restart — a plugin that bricks the
 * conversation it was installed for. So the switch is plugin-owned state kept
 * in memory, keyed by session id, and the *denial* is what reaches the model
 * (through the guard) rather than a stored permission record.
 *
 * The consequence, stated plainly because it is a real behaviour: the grant is
 * per session and does not survive a Host restart. A restarted Host comes back
 * with every session off, which is the safe direction for a capability that
 * moves the user's mouse. The user turns it on again from the same switch.
 *
 * ## Why a guard and not `restrict`
 *
 * `ctx.tools.restrict()` removes a tool from the model's schema, which reads as
 * "this plugin is not installed" and leaves the model with no way to tell the
 * user what to do. A guard keeps the tool visible and answers a call with a
 * message that names the switch, so the model can tell the user exactly how to
 * proceed. Guards are also monotonic — once registered they cannot be lifted by
 * a later registration — which is the property we want for a capability gate.
 *
 * @module dsh-zcode-cua/access
 */

/** Tool name the MCP client registers for this server's `js` tool. */
export const CUA_TOOL_NAME = "mcp__zcode-cua__js";

/**
 * Sessions that have switched the tool on.
 *
 * A Set of session ids. Ids are opaque branded strings owned by the Harness; we
 * never parse them, only compare them for equality.
 */
const granted = new Set();

/** Whether `sessionId` has opted in. */
export function isGranted(sessionId) {
  return typeof sessionId === "string" && granted.has(sessionId);
}

/** Turn the tool on or off for one session. */
export function setGranted(sessionId, value) {
  if (typeof sessionId !== "string" || sessionId === "") return;
  if (value) granted.add(sessionId);
  else granted.delete(sessionId);
}

/**
 * Drop every grant. Called when the plugin unloads so a re-mount does not
 * inherit authority granted to a previous generation of the plugin.
 */
export function clearGrants() {
  granted.clear();
}

/**
 * The guard body.
 *
 * Returns a denial for the Computer Use tool unless the calling session opted
 * in, and `undefined` (allow) for every other tool — a guard that denies tools
 * it does not own would silently break unrelated plugins.
 *
 * `execution.agent` is the calling Agent; its `id` is the SessionId. A call
 * with no agent (a subagent or a host-initiated call with no session attached)
 * cannot be matched to a grant and is denied: "no session" is not a session
 * that said yes.
 */
export function guardBody(execution) {
  if (execution?.name !== CUA_TOOL_NAME) return undefined;
  const sessionId = execution.agent?.id;
  if (isGranted(sessionId)) return undefined;
  return {
    reason:
      "Computer control is off for this session. Ask the user to switch it on with the " +
      "\"Computer control\" toggle under the message box, then call this tool again. " +
      "Do not retry before they confirm: the toggle is theirs to flip.",
    info: { name: "COMPUTER_USE_DISABLED", code: "COMPUTER_USE_DISABLED" },
  };
}
