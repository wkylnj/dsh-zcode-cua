---
name: zcode-computer-use
description: "用 ZCode 原生的电脑控制（Computer Use / CUA）操作桌面应用：点击、打字、截图、读 AX 树、拖拽、滚轮、快捷键。当需要操作本机原生桌面应用的 UI（不是网页内部），例如开关软件、填写本地表单、点击桌面按钮、查看窗口内容、截图确认界面状态时使用。工具是 mcp__zcode-cua__js，每个 cell 内必须先 bootstrap 再调 agent.computerUse.*。"
---

# ZCode 电脑控制（原汁原味）

本 skill 把 ZCode 官方桌面端自带的 Computer Use 完整搬到 DSH：走的是 ZCode 自己的
`node-repl-host` MCP server 与 `cua-helper` 原生执行体，只是外面套了一层协议翻译，
所以工具描述、执行环境、返回内容与在 ZCode 里完全一致。

## 工具

唯一工具：`mcp__zcode-cua__js`

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `code` | 是 | 在**全新的** Node.js 内核里执行的 JS，支持顶层 await |
| `title` | 是 | 一句话中文描述这次要做什么，不要提 js / JavaScript / node_repl |
| `timeout_ms` | 视情况 | 默认 60000；预计超过 30 秒时必须显式给，且 ≤ 120000 |

**每个 cell 都是全新内核**：变量、import、模块缓存全部消失，所以 `const app` 活不到下一个
cell。UI 状态本身是活的，重新绑定很便宜。

## 每次调用先 bootstrap

bootstrap 必须和实际操作放在**同一个 cell** 里，且放在最前面：

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
// 之后才能用 agent.computerUse.*
```

## 辅助功能优先（Accessibility first）

辅助功能是主路径：语义精确、能操作后台应用、不抢用户焦点。

1. **先观察**，在返回的 AX 树里按 role / name / title / value 找目标元素。
2. 找到就用**索引**操作；元素自报语义动作时也可以用 `performSecondaryAction`。
3. 可设置的元素优先 `setValue`，不要打字或粘贴；只有目标不可设置或内容是富文本时才用 `paste`。
4. **键盘是兜底**：只有没有元素能表达该操作，或用户明确要求键盘时才用 `pressKey`。
5. **坐标是最后手段**：仅用于 canvas、游戏、Electron 内容这类辅助功能看不见的地方。

不要因为快捷键更短就把可用的元素操作换成快捷键；同一个操作不要同时走辅助功能和视觉两条路。

**观察在后台应用上也有效，包括截图** —— 任何显示器、包括负坐标的窗口。
`has_image: false` 只表示这次没要像素（`getAXState`），不是截图失败。

**成功指的是 API 接受了动作，不等于应用照做了**。往网页内容编辑器里打字经常被接受但毫无变化，
所以要重新观察确认文字真的落进去了。

## API

```typescript
type Vec2 = [x: number, y: number];
type ObservationOptions = { emit?: boolean };
type StateOptions = ObservationOptions & { disableDiffing?: boolean };
type StateAndScreenshot = { state: string; screenshot?: Uint8Array };
type Direction = "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";
type MouseButton = "left" | "right" | "middle" | "l" | "r" | "m";
type SelectionType = "text" | "cursor_before" | "cursor_after";
type Strategy = "auto" | "a11y" | "event";

type ClickOptions = {
  mouseButton?: MouseButton;
  clickCount?: number;
  modifiers?: string;
  strategy?: Strategy;
};
type SelectTextOptions = { prefix?: string; suffix?: string; selectionType?: SelectionType };
type PasteOptions = { format?: "text" | "md" | "html" };
type PressKeyOptions = { holdSeconds?: number; strategy?: Strategy };

interface Target {
  getAXState(options?: StateOptions): Promise<string>;
  getScreenshot(options?: ObservationOptions): Promise<Uint8Array>;
  getAXStateAndScreenshot(options?: StateOptions): Promise<StateAndScreenshot>;
  elements(): Promise<{ index: number; kind: string; title: string | null; value: string | null; actions: string[] }[]>;

  paste(text: string, options?: PasteOptions): Promise<void>;
  click(target: number | Vec2, options?: ClickOptions): Promise<void>;
  drag(from: number | Vec2, to: number | Vec2, options?: { modifiers?: string }): Promise<void>;
  pressKey(key: string, options?: PressKeyOptions): Promise<void>;
  scroll(target: number | Vec2, direction: Direction, pages?: number): Promise<void>;
  selectText(elementIndex: number, text: string, options?: SelectTextOptions): Promise<void>;
  setValue(elementIndex: number, value: string): Promise<void>;
  typeText(text: string): Promise<void>;
  performSecondaryAction(elementIndex: number, action: string): Promise<void>;
}

interface App extends Target {}

type AppRef = { name?: string; bundle_id?: string; pid?: number; window_id?: number };
type AppInfo = { pid: number; name: string | null; bundle_id: string | null; active: boolean };
type State = { apps: AppInfo[] };

declare const agent: {
  computerUse: {
    getState(options?: ObservationOptions): Promise<State>;
    getApp(target: string | AppRef): Promise<App>;
    listApps(options?: ObservationOptions): Promise<AppInfo[]>;
    computer: Record<string, (args: object) => Promise<unknown>>;

    requestAccess(capabilities?: string[]): Promise<Record<string, unknown>>;
    stop(reason?: string): Promise<void>;
  };
};
```

完整参考在 `agent.documentation.get("computer-use")`，按需取；只在本页没给出的参数形状或
响应字段上才去读它。

## 主循环

**观察一次 → 操作 → 再观察**，然后决定下一步。

`agent.computerUse.getApp(...)` 只绑定应用，不显示任何东西；要看状态得调 `getAXState`。
绑定也会顺带启动应用（没有单独的 launch 工具）。参数是显示名或 bundle id —— 和
`listApps()` 返回的字符串一致 —— 或一个 `AppRef`。

用户点名某个应用时，**逐字符照抄**那个标识符，不要翻译、本地化、归一化、缩写或去掉后缀：
`{"name":"网易云音乐app"}` 不是 `{"name":"网易云音乐"}`；`{"name":"日历"}` 不是
`{"name":"Calendar"}`。改写过的名字会解析到别的应用或解析不到，报错是 "app not found"。
精确字符串解析不到时，调一次 `agent.computerUse.listApps()` 挑出匹配的标识符。

相关动作和最后一次收尾观察可以放在同一个 cell：

```js
const app = await agent.computerUse.getApp("记事本");
await app.click(box);
await app.typeText("hello");
await app.pressKey("Return");
await app.getAXState();
```

元素索引指向该应用**最近一次观察**，所以几个动作可以复用同一个索引，不必中间重新观察 ——
同一个 cell 里点完索引接着往里打字是合法的。**观察会重新编号**，索引要从最新那次取。
元素消失了会 fail closed，报 `ELEMENT_UNAVAILABLE`。

**树默认只回 diff**：只列相对本 cell 已展示过的树有增删改的元素，没变的行省略但索引仍然有效。
绑定后的第一棵树、以及 `getScreenshot` 或 `elements()` 之后的第一棵，永远是完整的。
需要完整树时传 `{ disableDiffing: true }`。如果一次独立观察报告无变化，不要在没有中间动作的
情况下立刻重复它。

大树会按优先级裁剪（保留祖先），表头会说明，此时索引会跳号。`app.elements()` 返回全部元素
（含被裁掉的）及其索引 —— 在 JS 里过滤，**绝不要猜索引**。

一次捕获只针对一个窗口：不给 `window_id` 时主/键窗口每次观察都会重新解析，所以刚弹出的模态框
会成为被捕获的窗口。动作失败或树读起来像应用的另一部分时，检查观察结果里的 `window` ——
对话框会出现在那里。读了它再去操作，或者关掉它（Escape 或它自己的取消）再重新观察。
**元素缺失不是动作成功的证据**。要用 `getApp({pid, window_id})` 钉住某个窗口，`list_windows`
能给 id。

## 输出

观察类调用会自己显示结果：`getAXState`、`getScreenshot`、`getAXStateAndScreenshot`、`getState`
和 `listApps` 都会 emit 自己的结果。

**绝不要把它们的返回值再喂给 `nodeRepl.write(...)` 或 `nodeRepl.emitImage(...)`**：一个结果里
出现第二张栅格图会破坏 one-raster 规则，整个帧会被丢弃，结果你一张图都看不到。
想拿到值又不想显示，传 `{ emit: false }`。

动作类方法不显示任何东西。

## 坐标

`x` 和 `y` 只能**看着当前返回的栅格图**来选，且 `0 <= x < width`、`0 <= y < height` 针对那张
栅格。这些整数原样提交；CUA 内部绑定当前栅格，并负责从返回栅格到原生派发的全部变换。
元素的窗口边界是诊断用的全局屏幕坐标点，**绝不能**拿来当坐标用。开始走视觉兜底时，丢弃此前
文本或辅助功能结果里的所有坐标类数字。

目标明确时就在当前栅格上操作；太小或太模糊就重新观察，不要猜几何。

指针动作被接受但毫无变化，通常意味着应用在真实指针所在的位置做了动作，重复也没用 ——
改用元素索引或键盘。

坐标被拒可能提示了一个意料之外的属主，或者说帧已过期 —— 窗口移动、缩放或被替换了。
重新观察拿当前栅格，或者改用元素索引（不依赖窗口几何）。
**绝不要为了坐标能落点而移动、缩放或关闭窗口**。

## 键盘

`pressKey` 接受单个键或用 `+` 连接的组合键，短名和 X keysym 风格都认：`"a"`、`"Return"`、
`"Tab"`、`"Control_L+a"`、`"super+c"`、`"Up"`。macOS 用 `cmd`；Linux 和 Windows 用 `ctrl`。
用 `{ holdSeconds }` 保持按住一段时长，而不是模拟重复按键。

键盘输入要绑定到应用或元素，**绝不发不绑定的键盘**。`paste` 用于富文本，或 `setValue`
设不进去的目标 —— 不是用来给可设置元素塞纯文本的。

`performSecondaryAction` 只接受当前树里该元素**自报**的动作，不要猜动作名。

同一时刻最多一个元素是 `focused`（持有键盘焦点）；缺失表示无法确定。

`selectText` 在可编辑元素里定位文本。用 `prefix`/`suffix` 区分重复匹配，用 `selectionType`
放置光标而不是选中。歧义匹配会被拒绝，而不是取第一个命中。

## 等待

观察本身会等 UI 稳定后再捕获。**不要在读状态前停顿或延迟** —— 不要 `setTimeout`，不要轮询循环。

## 错误与停止

动作成功 resolve 为 `undefined`，否则抛 `ComputerUseError`：

- `code` —— `PERMISSION_DENIED`、`NOT_AUTHORIZED`、`APP_NOT_FOUND`、`AMBIGUOUS_APP`、
  `LAUNCH_FAILED`、`INVALID_APP`、`ELEMENT_UNAVAILABLE`、`STALE_STATE`、`NOT_SETTABLE`、
  `NOT_SELECTABLE`、`ACTION_UNAVAILABLE`、`FOREGROUND_REQUIRED`、`CONTROLLER_BUSY`、
  `CONTROL_STOPPED`、`SCREEN_LOCKED`、`HELPER_UNAVAILABLE`、`VERSION_MISMATCH`、`TIMEOUT`、
  `STRUCTURED_STATE_UNAVAILABLE`、`INTERNAL`。
- `actionSent` —— 动作是否可能已经到达应用。非幂等动作只在它为 `false` 时重试；否则先观察，
  再根据看到的东西决定。
- `retry` —— `"reobserve"`、`"retry"` 或 `"never"`。

`CONTROLLER_BUSY` 表示另一个存活的 ZCode Computer Use 会话占着输入。它**永远不可重试**：
报告错误里的属主，请用户关掉那个会话。

遇到 `agent.computerUse.stop()`、kill switch、权限拒绝或不可重试的错误后**立即停止**。
访问被拒后不要改用另一种 UI 自动化技术。

**坚持到请求真正完成**：尝试了动作不算完成，要验证返回的状态里确实体现了结果。如果状态没变或
只是中间态，换别的方法。只有当请求的状态确实出现，或者你解释了一个自己解决不了的具体阻塞，
才回复用户。

## 低层工具面

`agent.computerUse.computer.<tool>(args)` 是低层接口。优先用上面的绑定对象 API；只有 API
表达不了的时候才用工具（窗口枚举、按键重复、在同一次调用里读回状态）。参数是严格的，
未声明的键会被拒绝。每个工具接受**一个**参数对象 —— 下面的名字是它的键，不是位置参数：
`get_app_state({ app_ref: { bundle_id: "com.apple.Notes" }, include_screenshot: true })`。

应用名用操作系统列出的名字（Windows：开始菜单里的名字，不是窗口标题）。
除了 Windows 上启动非打包应用、以及 `include_screenshot=true` 会取消最小化之外，
**没有别的操作会抢走用户焦点** —— 最小化状态的树完全可用，所以保持默认。

```
list_apps({})
list_windows({app_ref})
get_app_state({app_ref, include_screenshot?=false, disable_diffing?=false})

left_click({target, mouse_button?="left", click_count?=1, modifiers?="",
           strategy?, app_ref?, return_state?})
left_click_drag({from_target, to, modifiers?="", strategy?, app_ref?,
                return_state?})
scroll({target, scroll_direction, scroll_amount, strategy?, app_ref?,
       return_state?})

type({text, target?, app_ref?, strategy?, return_state?})
set_value({target, value, strategy?, app_ref?, return_state?})
select_text({target, text_range?, app_ref?, return_state?})
key({text, repeat?, hold_seconds?, app_ref?, strategy?, return_state?})
paste({text, format?="text", app_ref?, return_state?})
perform_action({target, action, app_ref?, return_state?})

request_access({capabilities?})
stop_computer_control({reason?})
```

参数形状：`app_ref` / `app` 是 `AppRef`，但这里的裸字符串会被当作 bundle id，
所以显示名要传 `{name: "记事本"}`。`scroll_direction` 是 `up|down|left|right`，
`scroll_amount` 是页数，`strategy` 是 `auto|a11y|event`，`return_state` 是
`compact|full|none`（在同一次调用里一并返回应用状态）。
`target`、`text_range`、`modifiers` 和响应形状见
`nodeRepl.write(await agent.documentation.get("computer-use"))`。

## 使用边界

- 能用专用 connector、API、CLI 或 skill 完成任务时，优先用它们。
- 浏览器和网页内部的任务用 Browser Use（本机未接），不要用 CUA 去点网页。
- 除用户明确要求外，不要用 AppleScript、`osascript`、JXA、System Events、shell 命令或
  其它 UI 自动化技术。
- **仅限主 agent**，绝不要把 Computer Use 委派给子 agent。
- **同一时刻只让一个会话操作桌面。** 整条链路上只有一份 helper——`@deepseek-ai/dsh-mcp-client`
  是 profile 级插件，DSH 只起一个实例、一个子进程。真正起作用的是上游的串行锁：桥接层给
  所有 DSH 会话传同一个进程级 `session_id`（`dsh-<uuid>`，进程启动时生成一次），上游
  `server.js` 用 `serialized(sessionKey, ...)` 把每次 `js` 执行按这个 id 排队，所以两个会话
  不会同时点击；代价是一个会话的长调用会把其它会话的 `js` 调用全堵在后面。如果你判断到
  另一个会话可能正在操作桌面，先向用户确认，不要两边同时动手。

## 运行环境

- 工具名前缀：`mcp__zcode-cua__js`
- 上游是 ZCode 官方的 `node-repl-host`；插件自己解析 ZCode 的三处安装位置
  （`node-repl-host` 的 MCP server、`computer-use` 插件根、`cua-helper` 原生执行体），
  都在 ZCode 的安装目录与插件缓存里。

**不要在技能正文里写死任何路径。** 上游升级后旧路径会失效。需要确认当前解析结果时，
调用一次 `js` 并 `nodeRepl.write(process.env.ZCODE_CUA_PLUGIN_ROOT)`。

**Browser Use 在本插件中不可用。** 上游 `node-repl-host` 确实实现了 Browser Use 桥
（`createBrowserBridgeGlobals`），但它需要宿主提供 `browserBroker`，而本插件只接了
Computer Use 桥。调用浏览器能力会得到
`Browser control is unavailable for this node_repl session`。需要操作网页时，用专门的
浏览器工具或让用户手动操作，不要退化成用坐标去点网页。
