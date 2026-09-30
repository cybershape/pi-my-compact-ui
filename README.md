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
│  ✓ thinking: The parser test is failing… · 1.2K tok
│  ✓ bash: npm test (3.2s)
└  ⠋ thinking: The assertion is off by one…
```

Expand the group to inspect tool arguments, result previews, and more of the
reasoning content:

```text
✓ tools done
├─ ✓ thinking · 1.2K tok
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

## License

MIT — see [LICENSE](./LICENSE).
