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

Groups always stay collapsed. Press `Ctrl+I` to inspect full tool arguments,
results, or reasoning content in a detail modal.

## Features

- Combines reasoning runs and tool calls into a single visual group, kept in the
  order the model produced them.
- Keeps every reasoning run as its own row: a spinner while it streams, a
  completion mark once it ends. Runs are never merged together.
- Removes Pi's native hidden-thinking placeholder components so an empty
  thinking label cannot leave phantom blank rows in the transcript.
- Supports streaming reasoning, streaming tool output, and parallel tool calls.
- Displays tool state, argument summaries, elapsed time, and reasoning summaries.
- Shows reasoning-token usage. During streaming it uses an estimate, then
  prefers provider-reported usage when available.
- Keeps reasoning and tool groups collapsed, including when Pi toggles `Ctrl+O`.
- Press `Ctrl+I` (or run `/compact-inspect`) to interactively select any tool call or thinking run with `↑`/`↓` and press `Enter` to pop up a centered modal showing full details. Press `Esc` or `q` to close.
- Leaves assistant Markdown and code-block rendering to Pi's native theme.
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
| `maxGroupEntries` | `5` | Maximum visible entries in a collapsed group |

The configuration is stored at:

```text
~/.pi/agent/compact-ui.json
```

Example:

```json
{
  "maxGroupEntries": 5
}
```

## Controls

| Action | Key |
|---|---|
| Inspect reasoning and tool details | `Ctrl+I` or `/compact-inspect` |
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

## Development and Testing

The public entry point is `index.ts`; implementations are split by responsibility in `src/`.
The build produces only the bundled `dist/extension.ts` declared in `pi.extensions`
and its source map. No JavaScript library entry or type declarations are published.
The TypeScript extension entry uses Pi's jiti transformation and host virtual
modules, avoiding a native ESM import of a second Pi installation. External Pi
dependencies are not bundled.
Pi packages are optional peers requiring `^1.0.3`, so installing the extension
does not automatically install another Pi. Local development and tests use the
same version range through development dependencies.

| Module | Responsibility |
|---|---|
| `config.ts` / `settings.ts` | Configuration persistence and interactive settings with injectable filesystem access |
| `helpers.ts` / `types.ts` / `constants.ts` | Formatting, streaming argument parsing, shared types and constants |
| `state.ts` | Runtime state; `createRuntimeState()` creates independent state snapshots |
| `thinking.ts` / `streaming-tools.ts` | Reasoning lifecycle, tool placeholders, and execution timing |
| `tool-group.ts` / `compaction.ts` / `modals.ts` | Collapsed groups, compaction summaries, and detail modals |
| `guards.ts` / `grouping.ts` / `assistant-patches.ts` | Component detection, grouping, text anchors, and native Pi integration |
| `animation.ts` / `extension.ts` | Animation scheduling, commands, and events |

```bash
npm run typecheck  # Strict TypeScript checks for source and tests
npm test           # Build and run the Node.js test suite
npm run check      # Typecheck and all tests; also used by CI and before publishing
```

`npm test` builds the extension before compiling and running the tests. CI and the
publish workflow therefore use `npm run check` without a separate build step.

Tests in `tests/` cover helpers, configuration, numeric editors, collapsed groups,
modals, streaming event order, text boundaries, historical anchors, hot reload,
native assistant Markdown, Pi's actual extension loader, and bundled-loader host
component identity. Tests require no new
dependencies; `.test-build/` is not committed or published.

Terminal changes also require manual verification with `pi -e ./index.ts`: check
streaming reasoning, parallel tools, text boundaries, groups staying collapsed
under `Ctrl+O`, `Ctrl+I` modals, settings persistence, and `/reload`.

## License

MIT — see [LICENSE](./LICENSE).
