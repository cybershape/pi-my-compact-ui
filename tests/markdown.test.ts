import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getCompactMarkdownTheme, normalizeCompactCodeBlockLines } from "../index.js";
import { runtime } from "../src/state.js";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark", false);

afterEach(() => { runtime.currentTheme = null; });

test("代码围栏转换为背景行，保留语言标签但去掉边框行", () => {
	assert.deepEqual(normalizeCompactCodeBlockLines(["before", "┌─ ts", "let x = 1", "└─", "after"], 14), [
		"before", " ts           ", " let x = 1    ", "after",
	]);
	assert.deepEqual(normalizeCompactCodeBlockLines(["┌─", "", "└─"], 5), ["     "]);
});

test("Markdown 表格边框不误判为代码块", () => {
	const table = ["┌────┬────┐", "│ a  │ b  │", "└────┴────┘"];
	assert.deepEqual(normalizeCompactCodeBlockLines(table, 30), table);
});

test("ANSI 高亮、中文和长代码换行保持目标宽度", () => {
	const rendered = normalizeCompactCodeBlockLines(["┌─", "\x1b[31m你好世界 hello\x1b[0m", "└─"], 8);
	assert.ok(rendered.length > 1);
	assert.ok(rendered.every((line) => visibleWidth(line) === 8));
	assert.ok(rendered.join("").includes("\x1b[31m"));
	assert.ok(stripTerminalSequences(rendered.join("")).includes("你好世"));
});

test("代码块背景调用当前主题，外侧 padding 保持不变", () => {
	const backgrounds: string[] = [];
	runtime.currentTheme = { bg: (color: string, text: string) => { backgrounds.push(color); return text; } };
	const lines = normalizeCompactCodeBlockLines(["  ┌─", "  x", "  └─"], 10, 2);
	assert.deepEqual(lines, ["   x    "]);
	assert.deepEqual(backgrounds, ["toolPendingBg"]);
});

test("未闭合代码块和极窄终端仍可渲染", () => {
	for (const width of [1, 2, 3]) {
		const lines = normalizeCompactCodeBlockLines(["┌─ js", "abcdef"], width);
		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
});

test("每个 Markdown 主题独立跟踪围栏开闭状态", () => {
	const a = getCompactMarkdownTheme();
	const b = getCompactMarkdownTheme();
	assert.equal(stripTerminalSequences(a.codeBlockBorder("```ts")), "┌─ ts");
	assert.equal(stripTerminalSequences(a.codeBlockBorder("```")), "└─");
	assert.equal(stripTerminalSequences(b.codeBlockBorder("```js")), "┌─ js");
});
