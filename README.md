# dsh-zcode-cua

Brings [ZCode](https://zcode.ai)'s Computer Use into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The model can click, type, read the accessibility tree and take screenshots of native desktop apps through a single `js` tool. DSH's own `dsh-cua-bundle` reports `unsupported-platform` on Windows, so this is the route that works there.

[中文](README.zh.md) · [Changelog](CHANGELOG.md)

## What it adds

One MCP tool, `mcp__zcode-cua__js`. Every call runs top-level `await` in a **fresh Node.js kernel**; the model drives the desktop with code:

```js
const root =
  process.env.ZCODE_CUA_PLUGIN_ROOT ??
  process.env.ZCODE_PLUGIN_ROOT ??
  process.env.CLAUDE_PLUGIN_ROOT;
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { setupComputerUseRuntime } = await import(
  pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href
);
await setupComputerUseRuntime({ globals: globalThis });

const app = await agent.computerUse.getApp({ pid: 1234 });
await app.getAXState();      // read the accessibility tree
await app.click(12);         // click by element index
await app.typeText("hello");
await app.getScreenshot();
```

`agent.computerUse` exposes `getState` / `getApp` / `listApps` / `requestAccess` / `stop`, plus fourteen low-level `computer.*` tools. The ordered path is: `getAXState()` first, find the element by role and name, then act on its index. Coordinates are the last resort, for canvas and Electron content accessibility cannot see.

The full API reference is `agent.documentation.get("computer-use")`, fetched on demand.

## The per-session switch

**A new session cannot drive the desktop.** The `js` tool stays visible in the tool list, but every call is denied until the session opts in:

> Computer control is off for this session. Ask the user to switch it on with the "Computer control" toggle under the message box, then call this tool again.

The switch is a pill at the right end of the row under the message box — `电脑控制 · 已关闭` / `电脑控制 · 已开启`. One click flips it, and only for the session you are looking at.

Why a switch rather than a setting: this tool clicks and types into whatever holds the keyboard. A profile-wide setting would mean one yes turns it on for every conversation, including the one that just asked a question and got an agent holding the mouse. Why a denial rather than hiding the tool: a tool missing from the schema reads as "the plugin is not installed", and the model would have no way to tell you which switch to flip.

Three details worth knowing:

- **The grant is per session and lives in memory.** Restarting DSH puts every session back to off. That is the safe direction for a capability that moves your mouse, so it is deliberate rather than a missing feature.
- **A call with no session attached is denied**, even while another session is on. "No session" is not a session that said yes.
- **Other tools are unaffected.** The guard only answers for `mcp__zcode-cua__js`; a guard that denied tools it does not own would quietly break unrelated plugins.

The switch shows a third state — `电脑控制 · 状态未知` — when the host route cannot be reached. "Off" and "could not ask" must not look alike, or a broken switch reads as a working one.

### The route is fenced by the connection service

The switch's route (`/plugins/dsh-zcode-cua/access`) **writes** the grant, so an unfenced route would be worse than no switch at all: any page the user has open in a browser could `POST` it and hand itself the ability to move the mouse. The route therefore asks `ctx.connection.requestRejection(req)` first and answers `401`/`403` before reading anything else — that is DSH's own Host/Origin fence plus browser authentication, so a foreign page is refused on both the origin and the credential.

Two properties of that fence are deliberate:

- **It fails closed.** A missing service, a throwing service, or a return value outside the documented `401 | 403 | undefined` all resolve to `403`. A fence that falls open still *reads* as guarded, so the defect would stay invisible until someone abused it.
- **`webServer` and `connection` are hard requirements** in the plugin's `inject` list, not optional injections. A Host that cannot supply the fence does not get the route at all — the switch disappears and the guard stays, rather than the route being served unprotected.

`test/fence.mjs` pins all of it: refused requests never reach the switch, allowed ones do, and every unexpected service shape answers `403`.

## The on-screen indicator

While a `js` call is running, a click-through overlay tells the user the computer is being driven: a blue glow around every screen edge, a banner, and a soft ring around the pointer. The banner's first line is always *DSH 正在控制电脑*; the second line is **what this call is doing**, taken from the `js` tool's required `title` argument — the same sentence the model already writes for the user.

The point is that it is **invisible to the model**. Every window is marked `WDA_EXCLUDEFROMCAPTURE`, so Windows omits it from any screenshot — `PrintScreen`, `Graphics.CopyFromScreen`, and the GDI/DWM path the CUA helper itself uses. Verified on this machine: a full-screen capture taken mid-tool-call contains no trace of the overlay, while the same capture with the affinity cleared shows the full artwork.

Nothing about it takes input or focus: the windows are `WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`, so clicks pass straight through, focus is never stolen, and it never appears in the taskbar or Alt-Tab.

Turn it off with `DSH_ZCODE_CUA_NO_OVERLAY=1`. The indicator is decoration — if PowerShell is missing, the C# fails to compile, or the host process dies, every path degrades to "no indicator" and tool calls keep working unchanged.

The visual design is ported from [windows-mcp](https://github.com/CursorTouch/Windows-MCP)'s `control_overlay`; the implementation is a standalone Win32 layered window in C#, compiled at runtime by Windows PowerShell 5.1 so the plugin ships no binaries and needs no build step.

## How it is wired

```
DSH  ──MCP stdio──▶  this plugin's server/index.js
                       ├─ injects ZCODE_CUA_PERMISSION_BROKER_SOCKET and friends
                       └──▶ node-repl-host (ZCode's official MCP server, one `js` tool)
                               └──▶ cua-helper (native Windows process, ax_native.node)
                                       └──▶ Win32 UI Automation / input injection
```

This plugin does exactly two things: **resolve ZCode's installation layout**, and **translate between MCP 1.x and the modern protocol**. The CUA execution logic is ZCode's own runtime, unmodified, which is why behaviour matches ZCode.

The upstream `js` tool is strict — anything beyond `code`, `timeout_ms` and `title` is refused — and this plugin passes it through untouched, adding no parameters.

## Install

### Prerequisites

1. **Windows**
2. **ZCode installed and launched at least once** — this plugin reuses the native helper in ZCode's install directory and redistributes none of it.
3. **DeepSeek Harness** (this is a DSH bundle)

### Into DSH

Option 1 (recommended): inside DSH, **Plugins → Add plugin**, then pick this directory. DSH links the checkout, so source edits take effect immediately.

Option 2: install from the checkout with the same command this was verified with:

```powershell
cd "D:\path\to\dsh-zcode-cua"
dsh plugin --profile desktop add "link:$PWD"
```

Restart DSH afterwards. The tool appears as `mcp__zcode-cua__js`, and the plugin row reads **ZCode computer control**.

> **The package name must stay `dsh-zcode-cua`**, unscoped. The registration row points at the relative path `node_modules/dsh-zcode-cua/server/index.js`; that is what makes one file work on every machine, and it assumes the package is installed under the profile's `node_modules` under exactly that directory name.

### Skill (optional, strongly recommended)

The tool works on its own, but the model will not know how to use it well. The skill lives at `skills/zcode-computer-use/SKILL.md` in this repository; install it into a DSH skill directory:

```powershell
# user level (every project)
Copy-Item -Recurse .\skills\zcode-computer-use "$env:USERPROFILE\.dsh\skills\zcode-computer-use"

# or project level (only that project)
Copy-Item -Recurse .\skills\zcode-computer-use "D:\your-project\.dsh\skills\zcode-computer-use"
```

DSH does **not** load skills from a plugin directory — it scans `<project>/.dsh/skills`, `<project>/.agents/skills` and `~/.dsh/skills` only, so this step is manual. Restart DSH afterwards.

## Configuration

To change anything, find the `zcode-cua` row in the profile's `cordis.patch.yml`:

```yaml
- id: zcode-cua
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: zcode-cua
    transport: stdio
    command: 'node'
    args: ['node_modules/dsh-zcode-cua/server/index.js']
    toolCallTimeoutMs: 180000
```

`command` defaults to `node`, which needs Node 18.17+ on PATH. The DSH desktop app ships its own Node; point `command` at it if you prefer an absolute path.

### Environment variables

When layout resolution fails — ZCode installed somewhere unusual — override the three probes:

| Variable | Points at |
|---|---|
| `ZCODE_BRIDGE_SERVER` | `node-repl-host`'s `dist/mcp/server.js` |
| `ZCODE_CUA_PLUGIN_ROOT` | the `computer-use` plugin root (holds `scripts/computer-use-client.mjs`) |
| `ZCODE_BRIDGE_HELPER_ROOT` | the `cua-helper` directory (holds `build/Release/ax_native.node`) |
| `DSH_ZCODE_CUA_NO_OVERLAY` | set to `1` to disable the on-screen indicator entirely |
| `DSH_ZCODE_CUA_KEEP_GHOST_CURSOR` | set to `1` to keep ZCode's own pointer overlay; by default it is suppressed so only the indicator above is on screen |

Usually none are needed: the plugin looks for ZCode in the **uninstall registry** (`InstallLocation`), in `ZCODE_HOME`, and in the conventional install locations.

## Limitations

- **Windows only.** It needs `resources/tools/cua-helper` from ZCode's install directory (the `ax_native.node` native module). ZCode currently has peer-identity verification disabled on Windows (`WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN = true` in `windows-helper.js`) — **this plugin did not open that gate**; the day ZCode closes it, this plugin stops working.
- **No picture-in-picture.** `ax_native.node` exports no `pip*` functions at all and `pipSessionEnabled` is always false on Windows, so there is nothing to enable. The banner and screen glow described above stand in for the missing visual feedback, and unlike a cursor overlay they are guaranteed absent from screenshots.
- **ZCode's own pointer overlay is suppressed on purpose.** The upstream launches the native helper with `--ghost-cursor-overlay` unconditionally — no setting or environment variable turns it off — so `server/helper-launcher.js` strips that flag before exec'ing the real helper. Two indicators disagreeing about what is happening is worse than one, and the ZCode overlay is a plain top-level window that any full-screen capture picks up. Set `DSH_ZCODE_CUA_KEEP_GHOST_CURSOR=1` to keep it. (Even when kept, it only paints inside a request scope that this path never supplies, for the reason recorded in 1.1.0.)
- **No Browser Use.** Upstream `node-repl-host` implements a Browser Use bridge, but it needs a `browserBroker` from the host and this plugin only wires the Computer Use bridge. Use DSH's own Browser Use for web pages.
- **Every `js` call is a fresh kernel.** Variables do not survive between calls, so bootstrap every time.
- **Do not drive the desktop from two sessions at once.** There is only one helper in the whole chain: `@deepseek-ai/dsh-mcp-client` is a profile-level plugin, so DSH runs a single instance and a single child process. What actually keeps two sessions apart is the upstream serialisation lock — the bridge passes the same process-wide `session_id` (`dsh-<uuid>`, generated once at startup) for every DSH session, and upstream `server.js` wraps each `js` execution in `serialized(sessionKey, ...)` keyed on that id, so calls from different sessions queue behind one another. Two sessions therefore cannot click at the same time, but a long call in one session blocks every other session's `js` calls until it returns. Keep desktop work in a single session; run other sessions in a different DSH window without Computer Use, or wait for the first one to finish.
- **The model really clicks and types on your desktop.** That is the capability, not a defect; disable the plugin row when you do not need it.

## Security notes

- The helper's permission broker socket is created inside this plugin's own process under a random name (`\\.\pipe\zcode-cua-helper-<uuid>`) and disappears with the process.
- This plugin reads, stores and forwards no ZCode or WorkBuddy credentials. It only drives a runtime already installed on the machine.
- Tool calls are governed by DSH's tool permission system; use a DSH permission preset for tighter limits.

## Development

```
server/paths.js          resolves ZCode's three install locations
index.js                 the Host half: the per-session tool guard and the switch's routes
client.js                the composer switch (browser module)
server/index.js          the MCP stdio server; spawns upstream and translates the protocol
server/access.js         the grant table and the guard body
server/overlay.js        owns the indicator's host process and brackets tool calls with it
server/overlay/          Overlay.cs (the Win32 layered window) and host.ps1 (its resident driver)
server/helper-launcher.js  drops the upstream's forced --ghost-cursor-overlay, then execs the helper
test/smoke.mjs           end-to-end: handshake, tools/list, one real js call, cancellation
test/overlay.mjs         end-to-end: the indicator appears during a call and leaves afterwards
test/access.mjs          unit: the guard denies, allows, and scopes grants per session
test/fence.mjs           unit: the switch's route refuses unauthenticated callers and fails closed
skills/                  the skill (installed manually into a DSH skill directory)
locale/                  plugin display metadata
docs/                    detail page image
cordis.patch.yml         the two registration rows
```

No build step, no runtime dependencies, pure ESM. Restart DSH after a change.

```sh
node test/access.mjs     # 13 checks
node test/fence.mjs      # 15 checks
node test/smoke.mjs      # 5 checks
node test/overlay.mjs    # 9 checks
```

## License

MIT. See [LICENSE](LICENSE).

This plugin contains no ZCode binaries or source. It drives a ZCode installation already present on your machine; those rights belong to their respective owners.
