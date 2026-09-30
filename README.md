<div align="center">

# compact-ui

### A quiet, structured home for Pi's reasoning and tool calls

![Pi Extension](https://img.shields.io/badge/Pi-Extension-7C3AED?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![TUI](https://img.shields.io/badge/UI-Compact_Tree-0F172A?style=flat-square)

</div>

Based on [pi-compact-ui](https://www.npmjs.com/package/pi-compact-ui) by [@geoffreychen777](https://www.npmjs.com/~geoffreychen777).

## Preview

Every entry is listed in stream order, oldest first, one line each. The leading
glyph is a spinner while the entry is still streaming:

```text
⠋ tool calling...
│  ✓ thinking The parser test is failing… (1.2k)
│  ✓ bash: npm test (3.2s)
└  ⠋ thinking The assertion is off by one…
```

Expand the group to inspect tool arguments, result previews, and more of the
reasoning content:

```text
✓ tools done
├─ ✓ thinking (1.2k)
│   The validation path now handles expired sessions…
├─ ✓ read: src/auth.ts (0.1s)
│   export async function authenticate() { …
└─ ✓ edit: src/auth.ts (0.2s)
    Updated src/auth.ts
```

## Features

- Combines reasoning runs and tool calls into a single visual group, kept in the
  order the model produced them.
- Keeps every reasoning run as its own row: a spinner while it streams, a
  completion mark once it ends. Runs are never merged together.
- Removes Pi's native hidden-thinking placeholder components so an empty
  thinking label cannot leave phantom blank rows in the transcript.
- Supports streaming reasoning, streaming tool output, and parallel tool calls.
- Displays tool state, argument summaries, elapsed time, and result previews.
- Shows reasoning-token usage. During streaming it uses an estimate, then
  prefers provider-reported usage when available.
- Follows Pi's standard `Ctrl+O` expand and collapse behavior.
- Press `Ctrl+I` (or run `/compact-inspect`) to interactively select any tool call or thinking run with `↑`/`↓` and press `Enter` to pop up a centered modal showing full details. Press `Esc` or `q` to close.
- Renders fenced code blocks as subtle theme-aware background panels with
  syntax highlighting and one character of horizontal padding instead of
  decorative top and bottom border rows.
- Preserves Pi's native execution semantics for `read`, `bash`, `powershell`, `edit`,
  `write`, `find`, `grep`, and `ls`.
- Gives compaction summaries a distinct, compact presentation.

## Installation

```bash
pi install npm:pi-my-compact-ui
```

Reload Pi:

```text
/reload
```

You can also load a local checkout temporarily:

```bash
pi -e ./pi-my-compact-ui/index.ts
```

## Configuration

Open the interactive settings menu:

```text
/compact-ui-config
```

Available settings:

| Setting | Default | Purpose |
|---|---:|---|
| `expandedToolLines` | `5` | Result-preview lines shown for each expanded tool |
| `expandedThinkingLines` | `10` | Reasoning-preview lines shown for each expanded reasoning run |

The configuration is stored at:

```text
~/.pi/agent/compact-ui.json
```

Example:

```json
{
  "expandedToolLines": 5,
  "expandedThinkingLines": 10
}
```

## Controls

| Action | Key |
|---|---|
| Expand or collapse reasoning and tool groups | `Ctrl+O` |
| Move through the settings menu | `Up` / `Down` |
| Adjust a numeric value | `Left` / `Right`, `-` / `+` |
| Save a setting | `Enter` |
| Close the settings menu | `Esc` |

## How It Works

compact-ui combines Pi's Assistant Message, Thinking, and Tool Execution
components at the presentation layer. It does not change the original messages
sent to the model or alter tool results.

Its main responsibilities are:

1. Capture reasoning blocks from the active assistant message and append each
   run to the active block as its own entry.
2. Track consecutive and parallel tool calls.
3. Combine them into a tree component with shared state, in stream order.
4. Seal the active group when visible assistant text begins, preserving clear
   message boundaries.

> [!NOTE]
> compact-ui overrides the registration of several built-in tools so it can
> control their presentation. Actual execution is still delegated to Pi's
> native tool implementations.

## 开发与测试

公开入口仍为 `index.ts`，实现按职责拆分在 `src/`：

| 模块 | 职责 |
|---|---|
| `config.ts` / `settings.ts` | 配置读写与交互式设置；读写器可注入，测试不写入用户配置 |
| `helpers.ts` / `types.ts` / `constants.ts` | 格式化、流式参数解析、共享类型和常量 |
| `state.ts` | 集中管理运行状态；`createRuntimeState()` 创建独立状态快照 |
| `thinking.ts` / `streaming-tools.ts` | 思考生命周期、工具占位行和执行时间 |
| `tool-group.ts` / `markdown.ts` / `compaction.ts` / `modals.ts` | 分组、代码块、压缩摘要与弹窗渲染 |
| `guards.ts` / `grouping.ts` / `assistant-patches.ts` | 组件识别、分组、正文锚点与 Pi 原生组件适配 |
| `animation.ts` / `extension.ts` | 动画调度、命令与事件接入 |

```bash
npm run typecheck  # 严格 TypeScript 检查，包含源码和测试
npm test           # 编译到 .test-build/，使用 Node 内置测试框架
npm run check      # 类型检查 + 全部测试，CI 和发布前自动执行
```

测试位于 `tests/`，覆盖纯逻辑、配置与数值编辑器、ANSI/中文代码块、
分组与弹窗、流式事件顺序、正文封组、历史锚点、热重载，以及 Pi 实际
TypeScript 扩展加载器。测试无需新增依赖；`.test-build/` 不进入版本控制或发布包。

涉及真实终端的改动还需手动验证：通过 `pi -e ./index.ts` 加载，检查流式
思考与并行工具、正文切换、`Ctrl+O` 展开、`Ctrl+I` 弹窗、设置保存和 `/reload`。

## License

MIT — see [LICENSE](./LICENSE).
