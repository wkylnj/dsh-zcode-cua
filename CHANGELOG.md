# Changelog

本文件记录本仓库的重要变更。

## 1.1.0 — 2026-11-22

稳定性加固。没有新增能力，改的全是「出问题时会发生什么」。

### 修复

- **取消信号被丢弃。** 原来 `handleMessage` 对所有 `id === undefined` 的消息直接 `return`，于是 DSH 取消工具调用时发来的 `notifications/cancelled` 根本到不了上游——用户按下中断之后，原生点击仍在继续落、键盘仍在继续打字。现在转发 `notifications/cancelled`、`notifications/progress`、`notifications/roots/list_changed` 三类通知。
- **上游崩溃被当成正常退出。** 原来上游一退出就 `process.exit(0)`，DSH 的 `reconnect` 策略因此永不触发，工具静默消失且不会自己回来，只能重启 DSH。现在区分「主动关闭」与「异常退出」：异常（被信号杀死、或父进程还活着时自行退出）报 `exit(1)`，让重连生效。
- **请求可能永久悬挂。** `upstreamRequest` 的 Promise 没有超时，应答一旦丢失就永远挂着，直到 DSH 自己的超时。现在有 240 秒上限（高于 `js` cell 的 120 秒上限与 `toolCallTimeoutMs` 的 180 秒），只用来兜住「答案丢了」，不干预正常的长调用。
- **崩溃时在途请求不清理。** 上游退出后，`pending` 里的 Promise 一直悬着。现在退出时全部 reject，并带上退出码/信号作为原因。
- **版本目录只取最新一个。** 最新版目录若损坏（更新中断、杀软隔离、磁盘写满），原来直接判定「Computer Use 不可用」，而旁边完好的旧版本明明能用。现在从新到旧逐个探测，取第一个真正完整的。

### 新增

- `test/smoke.mjs`：端到端冒烟测试，走真实的 legacy 握手 + 一次真实的 `js` 调用（枚举应用），5 项检查。改完代码跑 `node test/smoke.mjs` 就能确认主链路没被破坏。

### 文档

- 限制一节新增「不要用两个会话同时操作桌面」：每个 DSH 会话各自启动一个 helper，而 helper 的输入串行化（`windowsInputDispatchLease`）是进程内队列、不是全机互斥，两个会话同时点击会让鼠标键盘事件交错。
- 更正幽灵光标那段的原因说明。原来写「只有短命进程，浮层画不出来」是错的；真正原因是上游在 cua-broker 路径上从不填 `pip_session_context`，helper 收到 null 会话后主动抑制浮层。同时说明为什么不在本插件里绕开它。

## 1.0.0 — 2026-11-22

首个版本。

### 新增

- 一个 MCP 工具 `mcp__zcode-cua__js`，把 ZCode 的 Computer Use 运行时接进 DSH。每次调用在全新的 Node.js 内核里跑顶层 `await`，模型用代码点击、打字、读无障碍树、截图。
- 自动解析 ZCode 的三处安装位置：`node-repl-host`（上游 MCP server）、`computer-use`（客户端 SDK 与文档）、`cua-helper`（Windows 原生 helper）。ZCode 不在默认位置时按卸载注册表的 `InstallLocation`、`ZCODE_HOME`、常见安装目录依次探测，三者都支持环境变量覆盖。
- MCP 1.x 与现代协议（`2026-07-28`）双向适配：legacy 客户端本地应答握手，工具列表与调用转发上游，并剥掉现代协议独有的 `resultType` / `ttlMs` / `cacheScope` 字段。
- 插件展示元数据（中英双语）：`locale/en.json` 指向 `docs/DETAIL.md`，`locale/zh.json` 指向 `docs/DETAIL.zh.md`，两份文档各有自己语言的替代文本、共用同一张无文字插图。
- `skills/zcode-computer-use/SKILL.md`：Computer Use 的完整操作指南（无障碍优先、元素索引优先、坐标兜底、错误与重试语义）。

### 说明

- Windows 专用。依赖 ZCode 安装目录里的原生 helper，不重新分发 ZCode 的任何二进制。
- 没有屏幕上的操作提示（幽灵光标）——上游在 cua-broker 路径上从不填 `pip_session_context`，helper 收到 null 会话后主动抑制浮层。画中画小窗同理不可用（`ax_native.node` 没有 `pip*` 导出）。
- Browser Use 未接入：上游需要宿主提供 `browserBroker`，本插件只接了 Computer Use 桥。
- 注册行用相对路径 `node_modules/dsh-zcode-cua/server/index.js`，所以插件必须按包名 `dsh-zcode-cua` 安装（不带 scope）。从本地目录安装时 DSH 会建软链接，源码改动即时生效。
