# AGENTS.md

Guidelines for AI agents working on `pi-my-compact-ui`.

## Core Requirements

1. **Language**: All code, identifiers, comments, documentation, and commit messages MUST be in **English**.
2. **Mandatory Testing**: Run all tests after making any code or configuration change. Ensure all tests pass before completing the task.
   - Run tests: `npm test`
   - Full check (typecheck + test): `npm run check`

## Project Overview

- **Entry Point**: `index.ts` (registers the extension with Pi).
- **Source Code**: `src/` (TUI components, state management, patches, and inspectors).
- **Test Suite**: `tests/` (Node.js built-in test runner via `tsconfig.test.json`).

## Workflow

1. Keep modifications minimal and strictly scoped to the user request.
2. Maintain existing behavior for streaming reasoning, tool rendering, and interactive inspection (`Ctrl+I`).
3. Always verify changes by running `npm test`.
