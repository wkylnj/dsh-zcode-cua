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

平时不需要设——插件会从**卸载注册表**（`InstallLocation`）、`ZCODE_HOME`、以及常见安装位置三处去找 ZCode。

## 限制

- **Windows 专用。** 依赖 ZCode 安装目录里的 `resources/tools/cua-helper`（`ax_native.node` 原生模块）。ZCode 在 Windows 上暂时关闭了对端签名校验（`windows-helper.js` 的 `WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN = true`），**这不是本插件打开的门**；ZCode 一旦把这道门关上，本插件也随之失效。
- **没有屏幕上的操作提示。** ZCode 桌面端的幽灵光标由 helper 的常驻渲染调度器绘制，而这条链路上只有短命的调用进程，浮层画不出来。画中画小窗（PiP）同理不可用——`ax_native.node` 没有导出任何 `pip*` 函数，helper 在 Windows 上的 `pipSessionEnabled` 恒为 false。
- **Browser Use 不可用。** 上游 `node-repl-host` 实现了 Browser Use 桥，但它需要宿主提供 `browserBroker`，本插件只接了 Computer Use 桥。要浏览器操作请用 DSH 自己的 Browser Use。
- **每个 `js` 调用都是新内核。** 变量不跨调用存活，所以每次都要重新 bootstrap。
- **模型能在你的桌面上真实点击和打字。** 这是能力本身，不是缺陷；不需要时把这条插件行停用即可。

## 安全说明

- helper 的权限 broker socket 建在本插件进程内，名字是随机的（`\\.\pipe\zcode-cua-helper-<uuid>`），随进程退出消失。
- 本插件不读、不存、不转发任何 ZCode 或 WorkBuddy 的凭据。它只调用本机已经安装的运行时。
- 工具调用由 DSH 的工具权限体系约束；要更严的限制，用 DSH 的权限预设。

## 开发

```
server/paths.js     解析 ZCode 三处安装位置
server/index.js     MCP stdio 服务端；spawn 上游并翻译协议
skills/             技能（手动安装到 DSH 技能目录）
locale/             插件展示元数据
docs/               详情页图片
cordis.patch.yml    注册行
```

没有构建步骤，没有运行时依赖，纯 ESM。改完重启 DSH 生效。

## 许可

MIT。见 [LICENSE](LICENSE)。

本插件不含 ZCode 的任何二进制或源码。它调用的是你机器上已安装的 ZCode，相关权利归其各自所有者。
