# Changelog

本文件记录本仓库的重要变更。

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
- 没有屏幕上的操作提示（幽灵光标）——它需要 helper 进程内的常驻渲染调度器，这条链路上不存在。画中画小窗同理不可用。
- Browser Use 未接入：上游需要宿主提供 `browserBroker`，本插件只接了 Computer Use 桥。
- 注册行用相对路径 `node_modules/dsh-zcode-cua/server/index.js`，所以插件必须按包名 `dsh-zcode-cua` 安装（不带 scope）。从本地目录安装时 DSH 会建软链接，源码改动即时生效。
