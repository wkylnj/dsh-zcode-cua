# dsh-zcode-cua

把 [ZCode](https://zcode.ai) 的电脑控制（Computer Use）接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

模型可以通过一个 `js` 工具点击、打字、读无障碍树、截图，操作本机的原生桌面应用。DSH 自带的 `dsh-cua-bundle` 在 Windows 上报告 `unsupported-platform`，所以这是 Windows 上能用的一条路。

[English](README.md) · [更新日志](CHANGELOG.md)

## 它做什么

增加一个 MCP 工具 `mcp__zcode-cua__js`。每次调用在一个**全新的 Node.js 内核**里跑顶层 `await`，模型用代码驱动桌面：

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
await app.getAXState();      // 读无障碍树
await app.click(12);         // 按元素索引点击
await app.typeText("你好");
await app.getScreenshot();
```

`agent.computerUse` 暴露 `getState` / `getApp` / `listApps` / `requestAccess` / `stop`，以及底层 `computer.*` 十四个工具。顺路的做法是：先 `getAXState()` 拿树，按 role/name 找到元素索引再动手；只有 canvas 或无障碍看不见的内容才退到坐标。

完整 API 参考在 `agent.documentation.get("computer-use")`，按需取。

## 屏幕上的提示浮层

`js` 调用执行期间，屏幕上会出现一层可穿透的提示：四边蓝色光晕、顶部居中横幅，以及光标周围一圈柔光。横幅第一行固定是「DSH 正在控制电脑」，第二行是**这次调用正在做的事**——取自 `js` 工具必填的 `title` 参数，模型本来就要用它写一句面向用户的说明。

关键在于它**对模型不可见**。每个窗口都标了 `WDA_EXCLUDEFROMCAPTURE`，Windows 会把它从任何截图中排除——`PrintScreen`、`Graphics.CopyFromScreen`，以及 CUA helper 自己走的 GDI/DWM 路径都算在内。本机实测：在调用进行中抓全屏，画面里找不到浮层的任何痕迹；把 affinity 关掉再抓同一张，完整图案就都在。

它也不吃输入、不抢焦点：窗口样式是 `WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`，点击直接穿透，不会出现在任务栏或 Alt-Tab 里。

要关掉它，设 `DSH_ZCODE_CUA_NO_OVERLAY=1`。这层提示纯属装饰——PowerShell 缺失、C# 编译失败、宿主进程挂掉，任何一条路径都退化成「没有提示」并继续正常调用，不会拖累工具本身。

视觉设计移植自 [windows-mcp](https://github.com/CursorTouch/Windows-MCP) 的 `control_overlay`；实现是一个独立的 C# Win32 分层窗口，由 Windows 自带的 PowerShell 5.1 在运行时编译，所以插件不带任何二进制、也不需要构建步骤。

## 它是怎么接的

```
DSH  ──MCP stdio──▶  本插件 server/index.js
                        ├─ 注入 ZCODE_CUA_PERMISSION_BROKER_SOCKET 等环境变量
                        └──▶ node-repl-host（ZCode 官方 MCP server，只暴露一个 js 工具）
                                └──▶ cua-helper（Windows 原生进程，ax_native.node）
                                        └──▶ Win32 UI Automation / 输入注入
```

本插件只做两件事：**解析 ZCode 的安装布局**，以及**在 MCP 1.x 与现代协议之间翻译**。CUA 的执行逻辑完全来自 ZCode 自己的运行时，未做任何改动，所以行为与在 ZCode 里一致。

上游的 `js` 工具是严格的（`code` / `timeout_ms` / `title` 之外一律拒绝），本插件原样透传，不额外加参数。

## 安装

### 前提

1. **Windows**
2. **ZCode 已安装并至少登录/启动过一次** —— 本插件复用 ZCode 安装目录里的原生 helper，不重新分发它。
3. **DeepSeek Harness**（本插件是 DSH bundle）

### 装进 DSH

方式一（推荐）：在 DSH 里 **插件 → 添加插件**，选中这个目录。DSH 会建一个软链接，之后改源码即时生效。

方式二：从源码目录安装，与你机器上已验证的效果一致：

```powershell
cd "D:\path\to\dsh-zcode-cua"
dsh plugin --profile desktop add "link:$PWD"
```

装完重启 DSH。工具以 `mcp__zcode-cua__js` 出现，插件列表里是 **ZCode 电脑控制**。

> **包名必须是 `dsh-zcode-cua`**，不能带 scope。注册行里写的是相对路径 `node_modules/dsh-zcode-cua/server/index.js`，这是让同一个文件在别人机器上也能用的代价——它假定包被装在 profile 的 `node_modules` 下且目录名就是包名。

### 技能（可选，强烈建议）

工具本身能用，但模型不知道该怎么用。技能文件在这个仓库的 `skills/zcode-computer-use/SKILL.md`，把它装到 DSH 的技能目录：

```powershell
# 用户级（所有项目可用）
Copy-Item -Recurse .\skills\zcode-computer-use "$env:USERPROFILE\.dsh\skills\zcode-computer-use"

# 或者项目级（只在某个项目里可用）
Copy-Item -Recurse .\skills\zcode-computer-use "D:\your-project\.dsh\skills\zcode-computer-use"
```

DSH **不会**从插件目录自动加载技能——它只扫描 `<项目>/.dsh/skills`、`<项目>/.agents/skills` 和 `~/.dsh/skills`，所以这一步得手动做。装完重启 DSH。

## 配置

想改的时候，在 profile 的 `cordis.patch.yml` 里找 `zcode-cua` 那一行：

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

`command` 默认是 `node`，需要 Node 18.17+ 在 PATH 上。DSH 桌面端自带一份 Node，也可以用绝对路径指向它。

### 环境变量

解析 ZCode 位置失败时（比如 ZCode 装在很偏的地方），用这三个变量覆盖：

| 变量 | 指向 |
|---|---|
| `ZCODE_BRIDGE_SERVER` | `node-repl-host` 的 `dist/mcp/server.js` |
| `ZCODE_CUA_PLUGIN_ROOT` | `computer-use` 插件根目录（含 `scripts/computer-use-client.mjs`） |
| `ZCODE_BRIDGE_HELPER_ROOT` | `cua-helper` 目录（含 `build/Release/ax_native.node`） |
| `DSH_ZCODE_CUA_NO_OVERLAY` | 设为 `1` 即完全关闭屏幕提示浮层 |
| `DSH_ZCODE_CUA_KEEP_GHOST_CURSOR` | 设为 `1` 保留 ZCode 自带的指针浮层；默认会被抑制，屏幕上只留上面这层提示 |

平时不需要设——插件会从**卸载注册表**（`InstallLocation`）、`ZCODE_HOME`、以及常见安装位置三处去找 ZCode。

## 限制

- **Windows 专用。** 依赖 ZCode 安装目录里的 `resources/tools/cua-helper`（`ax_native.node` 原生模块）。ZCode 在 Windows 上暂时关闭了对端签名校验（`windows-helper.js` 的 `WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN = true`），**这不是本插件打开的门**；ZCode 一旦把这道门关上，本插件也随之失效。
- **没有画中画小窗。** `ax_native.node` 没有导出任何 `pip*` 函数，helper 在 Windows 上的 `pipSessionEnabled` 恒为 false，没有可开启的东西。上面说的横幅与四边光晕补上了这块视觉反馈，而且它们保证不会出现在截图里。
- **ZCode 自带的指针浮层是被主动抑制的。** 上游启动原生 helper 时**无条件**追加 `--ghost-cursor-overlay`，没有任何设置或环境变量能关掉，所以 `server/helper-launcher.js` 在 exec 真 helper 之前把这个参数剥掉。两个提示对「正在发生什么」说法不一致比只有一个更糟，而且 ZCode 那个浮层是普通顶层窗口，任何全屏抓图都会带上它。设 `DSH_ZCODE_CUA_KEEP_GHOST_CURSOR=1` 可以保留。即使保留，它也只在「请求作用域」内绘制，而这条路径从不提供该作用域（原因记在 1.1.0）。
- **Browser Use 不可用。** 上游 `node-repl-host` 实现了 Browser Use 桥，但它需要宿主提供 `browserBroker`，本插件只接了 Computer Use 桥。要浏览器操作请用 DSH 自己的 Browser Use。
- **每个 `js` 调用都是新内核。** 变量不跨调用存活，所以每次都要重新 bootstrap。
- **不要用两个会话同时操作桌面。** 整条链路上只有一份 helper：`@deepseek-ai/dsh-mcp-client` 是 **profile 级**插件，DSH 只起一个实例、一个子进程。真正把两个会话隔开的是上游的串行锁——桥接层给所有 DSH 会话传的是同一个进程级 `session_id`（`dsh-<uuid>`，进程启动时生成一次），上游 `server.js` 用 `serialized(sessionKey, ...)` 把每次 `js` 执行按这个 id 排队，所以不同会话的调用只能一个接一个地跑。好处是两个会话不会同时操作桌面，代价是一个会话的长调用会把其它会话的 `js` 调用全堵在后面，直到它返回。桌面操作请集中在单个会话里做；其它会话在另一个 DSH 窗口里跑别的事、不要用 Computer Use，或者等第一个会话做完。
- **模型能在你的桌面上真实点击和打字。** 这是能力本身，不是缺陷；不需要时把这条插件行停用即可。

## 安全说明

- helper 的权限 broker socket 建在本插件进程内，名字是随机的（`\\.\pipe\zcode-cua-helper-<uuid>`），随进程退出消失。
- 本插件不读、不存、不转发任何 ZCode 或 WorkBuddy 的凭据。它只调用本机已经安装的运行时。
- 工具调用由 DSH 的工具权限体系约束；要更严的限制，用 DSH 的权限预设。

## 开发

```
server/paths.js            解析 ZCode 三处安装位置
server/index.js            MCP stdio 服务端；spawn 上游并翻译协议
server/overlay.js          管理提示浮层的宿主进程，并用它包住每次工具调用
server/overlay/            Overlay.cs（Win32 分层窗口）与 host.ps1（常驻驱动）
server/helper-launcher.js  剥掉上游强加的 --ghost-cursor-overlay 后再 exec 真 helper
test/smoke.mjs             端到端：握手、tools/list、一次真实 js 调用、取消通知
test/overlay.mjs           端到端：调用期间浮层出现，结束后消失
skills/                    技能（手动安装到 DSH 技能目录）
locale/                    插件展示元数据
docs/                      详情页图片
cordis.patch.yml           注册行
```

没有构建步骤，没有运行时依赖，纯 ESM。改完重启 DSH 生效。

```sh
node test/smoke.mjs      # 5 项检查
node test/overlay.mjs    # 9 项检查
```

## 许可

MIT。见 [LICENSE](LICENSE)。

本插件不含 ZCode 的任何二进制或源码。它调用的是你机器上已安装的 ZCode，相关权利归其各自所有者。
