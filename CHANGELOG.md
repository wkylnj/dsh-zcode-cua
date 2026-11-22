# Changelog

本文件记录本仓库的重要变更。

## 1.3.0 — 2026-11-22

新增按会话的电脑控制开关：新会话默认**不能**操作桌面，由用户在输入框下方自己打开。

### 新增

- **按会话的开关。** 输入框下方那一行最右边多一枚胶囊：`电脑控制 · 已关闭` / `电脑控制 · 已开启`，点一下切换，只对当前会话生效。宿主侧由 `index.js` 注册 `ctx.tools.guard()` 实现，客户端是 `client.js`（浏览器模块），状态由 `GET/POST /plugins/dsh-zcode-cua/access` 读写。
- **`server/access.js`**：授权表（模块级 `Set`，按会话 id）与守卫本体。守卫只对 `mcp__zcode-cua__js` 作答，其它工具一律放行；未授权时返回带 `COMPUTER_USE_DISABLED` 码的拒绝，文案直接告诉模型去开哪个开关。
- **`test/access.mjs`**：13 项单元检查，覆盖默认拒绝、放行非本插件工具、授权按会话隔离、无会话一律拒绝、撤销后重新拒绝、`clearGrants` 清空、空 id 不产生授权。
- **`cordis.patch.yml` 增加第二行** `zcode-cua-access`（本包自己的宿主入口）。原来只有 `zcode-cua`（MCP server）一行。

### 设计取舍

- **默认拒绝，而不是默认允许 + 事后撤销。** 这个工具会点击、会往当前持有键盘的窗口里打字。新会话先拿到它，等于用户只是问了个问题却得到一个握着鼠标的 agent。
- **用 `ctx.tools.guard()` 而不是 `ctx.tools.restrict()`。** 后者把工具从 schema 里摘掉，读起来像「插件没装」，模型无法告诉用户该开哪个开关；守卫保留工具可见性，并把「为什么被拒、去哪里开」写进拒绝文案。
- **授权状态不写进 session log。** Harness 会拒绝重开会话里它不认识的 `type`（除非信封带 `ignorable: true`，而运行时 `Session.append()` 设不了这个标记）。把权限记录写进日志会让会话重启后打不开——一个把对话弄坏的插件比一个默认关闭的开关糟得多。
- **授权不跨 Host 重启。** 重启后所有会话回到关闭。对会移动鼠标的能力来说这是安全方向，所以是刻意的，文档里写明。
- **没有会话可归属的调用一律拒绝**，即使别的会话已授权。「没有会话」不等于「会话说了可以」。
- **开关有第三种状态 `状态未知`。** 宿主路由够不着时显示它而不是「已关闭」——「关闭」和「问不到」不能长得一样，否则坏掉的开关看起来跟好的一样。

### 变更

- `package.json`：`main` 与 `"."` 导出改指 `./index.js`（宿主入口）；新增 `"./client"` 导出、`"./server"` 导出（MCP server 的显式路径）、`files` 补 `index.js` / `client.js`；新增 `dsh.client` 段（`platform: "web"`、`immediately: true`、`inject: ["@deepseek-ai/dsh-client-ui-conversation"]`）。
- README 中英文各新增「按会话开关 / The per-session switch」一节，开发清单与测试命令同步。

## 1.2.1 — 2026-11-22

三个实测反馈的修复：浮层文字乱码、短调用看不到浮层、ZCode 自带的幽灵光标还在。

### 修复

- **横幅中文乱码。** Node 以 UTF-8 写 stdin，而 PowerShell 5.1 的 `[Console]::In.ReadLine()` 按系统 OEM 代码页（中文 Windows 是 936/GBK）解码，中文全变成乱码。`server/overlay/host.ps1` 改用显式 UTF-8 流：`New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)` 与对应的 `StreamWriter`，`$utf8 = New-Object System.Text.UTF8Encoding($false)`（不能带 BOM，否则 JSON 行解析失败）。
- **短调用看不到浮层。** `enter()` 同步把「已显示」置位，而真正的 `show` 是异步的，首次调用还要先编译 C#（约 1–2 秒）。比编译更短的调用会在窗口建好之前就发出 `hide`，于是浮层永远没机会出现——这就是「有时候被控制了但没有浮层」。现在 `leave()` 会等未回话的 `show` 再拆，并保证最短可见时间 `MIN_VISIBLE_MS = 900`；新调用到达时取消待执行的 `hide`，避免上一轮的延迟关闭打断下一轮。
- **横幅不更新为本次动作。** 浮层已经在屏幕上时再次 `enter()` 会重绘，让第二行显示**这一次**调用做的事，而不是上一次留下的文字。
- **ZCode 的幽灵光标又出现了。** 上游 `node-repl-host` 启动原生 helper 时**无条件**追加 `--ghost-cursor-overlay`（`server.js:121868`，没有任何设置或环境变量能关掉），helper 于是自带一个常驻指针浮层。新增 `server/helper-launcher.js`：helper recipe 的 `entryPath` 指向它，它剥掉这个参数后再 exec 真 helper。不改任何上游文件；`DSH_ZCODE_CUA_KEEP_GHOST_CURSOR=1` 可恢复原状。

### 变更

- `test/overlay.mjs` 从 7 项增到 9 项，新增「极短调用也要出现浮层」与「之后要消失」两条回归。
- 环境变量表新增 `DSH_ZCODE_CUA_KEEP_GHOST_CURSOR`。

## 1.2.0 — 2026-11-22

新增屏幕上的操作提示浮层：`js` 调用执行期间，用户能看到 AI 正在操作这台电脑，而模型截的图里看不到它。

### 新增

- **提示浮层。** 四边蓝色光晕 + 顶部居中横幅 + 光标周围柔光。横幅第一行固定「DSH 正在控制电脑」，第二行显示**本次调用正在做的事**（取 `js` 工具必填的 `title` 参数）；没给 title 时回落成「正在执行操作…」。视觉规格移植自 [windows-mcp](https://github.com/CursorTouch/Windows-MCP) 的 `control_overlay`，实现是完全独立的 C# Win32 分层窗口（`server/overlay/Overlay.cs`），由 Windows 自带的 PowerShell 5.1 在运行时用 `Add-Type` 编译，所以插件仍然不带二进制、不需要构建步骤。
- **截图排除。** 每个窗口都标 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`，Windows 会把它从任何截图路径中排除。本机实测：调用进行中抓全屏，画面里找不到浮层；把 affinity 关掉再抓同一张，完整图案都在。
- **不吃输入。** 窗口样式 `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`，点击穿透、不抢焦点、不进任务栏与 Alt-Tab。
- **`server/overlay.js`**：浮层的宿主管理器。常驻一个 `host.ps1` 进程（编译 C# 与建窗口要几百毫秒，只付一次），把工具调用包成「进入 / 离开」，并用嵌套计数保证两个重叠的调用不会互相把浮层关掉。
- **`test/overlay.mjs`**：端到端验证三件事——空闲时无窗口、`js` 调用期间六个窗口全部可见、调用结束后全部消失。7 项检查。
- 环境变量 `DSH_ZCODE_CUA_NO_OVERLAY=1` 可完全关掉浮层。

### 设计取舍

- **失败一律降级，绝不阻断调用。** 浮层是装饰：PowerShell 缺失、C# 编译失败、宿主进程挂掉，全部退化成「没有提示」并照常调用。一个因为状态徽标坏掉就不能用的电脑控制插件是坏交易。宿主在启动后一秒内死亡会被标记为不可用而不再重试，避免每次调用都去撞同一个编译错误。
- **只对 `js` 这个工具亮。** 上游只有这一个工具，Computer Use 的每个动作都在它里面；写成「任何工具调用都亮」会让以后新增的非桌面工具也顶着「正在操作电脑」的横幅。
- **DPI 感知必须在建窗口之前设。** 否则进程是 DPI-unaware，`GetSystemMetrics` 报的是虚拟化后的小尺寸、合成器又把窗口放大，横幅会偏到右半边、被屏幕边缘截断（实测踩到）。
- **`RegisterClassEx` / `CreateWindowEx` 两侧都要 `CharSet.Unicode`。** 缺了会以 ANSI 名字注册、再以 UTF-16 查找，每次创建都返回 1411 `ERROR_CLASS_DOES_NOT_EXIST`，而 `RegisterClassEx` 明明成功（实测踩到）。
- **C# 里的类必须是 `public`。** `Add-Type` 发到动态程序集，只能访问导出类型；`internal` 编译得过，然后 PowerShell 报「找不到类型」（实测踩到）。

### 变更

- 限制一节里「没有屏幕上的操作提示」改为「没有幽灵光标，也没有画中画」，并说明新浮层替代了这两者、且保证不进截图。幽灵光标那段的成因分析保留。
- 开发一节补充 `server/overlay.js`、`server/overlay/`、`test/overlay.mjs` 与两条测试命令。

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

### 更正

- 上面「文档」第一条把并发限制的原因写错了。原文说「每个 DSH 会话各自启动一个 helper、`windowsInputDispatchLease` 是进程内队列」，这不是实情：`@deepseek-ai/dsh-mcp-client` 是 profile 级插件，整个 DSH 只有一份 helper、一个子进程。真正的原因是桥接层给所有 DSH 会话传同一个进程级 `session_id`（`dsh-<uuid>`），上游 `server.js` 用 `serialized(sessionKey, ...)` 据此把它们排成一队——两个会话因此不会同时操作桌面，代价是一个会话的长调用会阻塞其它会话的 `js` 调用。结论不变；README 与 `skills/zcode-computer-use/SKILL.md` 的表述已同步更正。

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
