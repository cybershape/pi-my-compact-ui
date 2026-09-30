import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import {
	estimateTextTokens, formatTokenK, formatWorkedTime, isCtrlI,
	locateStreamingToolCall, oneLine, shortenPath, streamingToolArgs,
	thinkingTokenLabel, toolResultText, toolStatus, toolSummary,
} from "../src/helpers.js";
import type { ThinkingEntry } from "../src/types.js";

test("单行摘要折叠空白、处理空值并截断", () => {
	assert.equal(oneLine("  a\n b\t c  "), "a b c");
	assert.equal(oneLine(null), "");
	assert.equal(oneLine("abcdef", 4), "abc…");
	assert.equal(oneLine(123), "123");
});

test("路径与工具摘要保留默认值和参数优先级", () => {
	assert.equal(shortenPath(`${homedir()}/src/a.ts`), "~/src/a.ts");
	assert.equal(shortenPath("src/a.ts"), "src/a.ts");
	const cases: [string, unknown, string][] = [
		["bash", { command: "echo\n hello" }, "echo hello"],
		["powershell", { command: "Get-Item ." }, "Get-Item ."],
		["read", {}, "…"], ["write", { path: "a.ts" }, "a.ts"],
		["edit", { path: "a.ts" }, "a.ts"], ["ls", {}, "."],
		["find", { pattern: "*.ts" }, "*.ts in ."],
		["grep", { pattern: "TODO", path: "src" }, "TODO in src"],
		["web_search", { query: "a\n b" }, "a b"],
		["subagent", { agent: "review", task: "ignored" }, "review"],
		["custom", { path: "p", query: "q" }, "p"],
		["custom", { url: "https://example.com" }, "https://example.com"],
		["custom", undefined, "…"],
	];
	for (const [name, args, content] of cases) assert.deepEqual(toolSummary(name, args), { name, content });
});

test("token 估算和显示在边界保持稳定", () => {
	assert.equal(estimateTextTokens(""), 0);
	assert.equal(estimateTextTokens("12345"), 2);
	for (const [tokens, expected] of [[0, "0.0K"], [99, "<0.1K"], [100, "0.1K"], [1250, "1.3K"], [100000, "100K"]] as const) {
		assert.equal(formatTokenK(tokens), expected);
	}
	for (const [tokens, expected] of [[-1, "(0t)"], [999, "(999t)"], [1000, "(1.0k)"], [100000, "(100k)"]] as const) {
		assert.equal(thinkingTokenLabel({ tokens } as ThinkingEntry), expected);
	}
});

test("工具状态优先处理错误和部分结果", () => {
	assert.equal(toolStatus(undefined), "pending");
	assert.equal(toolStatus({ executionStarted: true }), "pending");
	assert.equal(toolStatus({ result: { content: [] } }), "success");
	assert.equal(toolStatus({ isPartial: true, result: {} }), "pending");
	assert.equal(toolStatus({ isPartial: true, result: { isError: true } }), "error");
});

test("输出只提取文本并保留文本块顺序", () => {
	assert.equal(toolResultText(undefined), "");
	assert.equal(toolResultText({ result: { content: [
		{ type: "text", text: " first " }, { type: "image", data: "ignored" }, { type: "text", text: "second " },
	] } }), "first \nsecond");
});

test("流式工具参数优先使用结构化参数，缺失时回退到部分文本", () => {
	const args = { command: "echo ok" };
	assert.equal(streamingToolArgs({ arguments: args, partialJson: "ignored" }), args);
	assert.deepEqual(streamingToolArgs({ name: "bash", partialJson: " echo" }), { command: "echo" });
	assert.deepEqual(streamingToolArgs({ name: "read", partialArgs: " src/a" }), { path: "src/a" });
	assert.deepEqual(streamingToolArgs({ name: "custom", partialJson: "query" }), { query: "query" });
	assert.deepEqual(streamingToolArgs(undefined), {});
});

test("工具调用定位支持索引、事件 ID 和仅事件块", () => {
	const block = { type: "toolCall", id: "a", name: "read" };
	const content = [{ type: "text" }, block];
	assert.deepEqual(locateStreamingToolCall(content, { contentIndex: 1 }), { index: 1, block });
	assert.deepEqual(locateStreamingToolCall(content, { toolCall: block }), { index: 1, block });
	assert.deepEqual(locateStreamingToolCall([], { toolCall: block }), { index: 0, block });
	assert.equal(locateStreamingToolCall(content, { contentIndex: 0 }), undefined);
});

for (const [ms, expected] of [[0, "1s"], [1499, "1s"], [1500, "2s"], [60000, "1m"], [61000, "1m 1s"], [3600000, "1h"], [3660000, "1h 1m"]] as const) {
	test(`耗时格式化 ${ms}ms`, () => assert.equal(formatWorkedTime(ms), expected));
}

test("Ctrl+I 不抢占 Tab，支持扩展键盘协议并忽略释放事件", () => {
	assert.equal(isCtrlI("\t"), false);
	assert.equal(isCtrlI("x"), false);
	assert.equal(isCtrlI("\x1b[105;5u"), true);
	assert.equal(isCtrlI("\x1b[105;5:3u"), false);
});
