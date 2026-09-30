import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { createRuntimeState, runtime } from "../src/state.js";
import { ToolGroupComponent } from "../src/tool-group.js";
import { createThinkingEntry, finalizeActiveThinking, refreshSealedThinkingTokens, updateActiveThinkingTokens } from "../src/thinking.js";
import { absorbPreparingTool, noteStreamingToolCall, takePreparingTool, toolElapsed } from "../src/streaming-tools.js";
import { PARENT_KEY } from "../src/constants.js";
import { DetailModalComponent, InspectSelectorModal } from "../src/modals.js";
import type { ThinkingEntry } from "../src/types.js";
import { config, DEFAULT_CONFIG } from "../src/config.js";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark", false);
const originalConfig = { ...config };
beforeEach(() => {
	Object.assign(runtime, createRuntimeState());
	Object.assign(config, DEFAULT_CONFIG);
});
afterEach(() => {
	Object.assign(config, originalConfig);
	if (runtime.animTimer) clearTimeout(runtime.animTimer);
	runtime.activeModalComponent?.dispose();
});

function thinking(text: string, active = false): ThinkingEntry {
	return { kind: "thinking", id: 1, text, active, tokens: 10, tokensExact: false, owner: null };
}
function tool(id: string, result?: unknown) {
	return { toolName: "bash", toolCallId: id, args: { command: "echo ok" }, result, render: () => ["native"], invalidate() {} };
}

test("新的运行状态不共享集合或锚点", () => {
	const a = createRuntimeState(), b = createRuntimeState();
	a.handledTextIndexes.add(1);
	a.toolStarts.set("a", 10);
	assert.equal(b.handledTextIndexes.size, 0);
	assert.equal(b.toolStarts.size, 0);
	assert.notEqual(a.assistantContentStates, b.assistantContentStates);
});

test("思考估算、完成与迟到的精确 token 更新", () => {
	const entry = createThinkingEntry();
	runtime.activeThinkingIndex = 2;
	runtime.activeThinkingBlocks.set(2, "12345");
	updateActiveThinkingTokens({});
	assert.equal(entry.tokens, 2);
	assert.equal(entry.text, "12345");
	assert.equal(entry.tokensExact, false);
	finalizeActiveThinking();
	assert.equal(entry.active, false);
	assert.equal(runtime.activeThinking, null);
	assert.ok(runtime.sealedThinkingIndexes.has(2));
	refreshSealedThinkingTokens(120);
	assert.equal(entry.tokens, 120);
	assert.equal(entry.tokensExact, true);
	refreshSealedThinkingTokens(240);
	assert.equal(entry.tokens, 120);
});

test("无效 reasoning usage 不覆盖估算，流中精确值不再回退", () => {
	const entry = createThinkingEntry();
	runtime.activeThinkingBlocks.set(0, "12345678");
	updateActiveThinkingTokens({ usage: { reasoning: "invalid" } });
	assert.equal(entry.tokens, 2);
	updateActiveThinkingTokens({ usage: { reasoning: 31 } });
	assert.equal(entry.tokens, 31);
	finalizeActiveThinking();
	refreshSealedThinkingTokens(0);
	assert.equal(entry.tokens, 31);
});

test("分组保持条目顺序，忽略空思考，思考只能有一个 owner", () => {
	const a = new ToolGroupComponent(), b = new ToolGroupComponent();
	const entry = thinking("plan");
	a.addThinking(entry);
	a.addThinking(entry);
	b.addThinking(entry);
	a.addThinking(thinking("   "));
	const call = tool("a", { content: [] });
	a.addTool(call);
	assert.deepEqual(a.getVisibleEntries().map((item) => item.kind), ["thinking", "tool"]);
	assert.equal(b.entries.length, 0);
	assert.equal((call as any)[PARENT_KEY], a);
	a.removeTool(call);
	assert.equal(a.children.length, 0);
	assert.equal(a.getVisibleEntries().length, 1);
	assert.equal((call as any)[PARENT_KEY], undefined);
});

test("折叠和展开渲染遵守宽度、单条目无树头，预览受配置限制", () => {
	const group = new ToolGroupComponent();
	group.addTool(tool("a", { content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") }] }));
	assert.ok(!group.render(60).join("\n").includes("tools done"));
	group.setExpanded(true);
	const expanded = group.render(60);
	assert.ok(expanded.join("\n").includes("row 0"));
	assert.ok(expanded.join("\n").includes("…"));
	assert.ok(!expanded.join("\n").includes("row 29"));
	for (const width of [1, 8, 20, 80]) assert.ok(group.render(width).every((line) => visibleWidth(line) <= width));
	group.addThinking(thinking("after tool"));
	group.setExpanded(false);
	const rows = group.render(60).join("\n");
	assert.ok(rows.includes("tools and thinking done"));
	assert.ok(rows.indexOf("bash") < rows.indexOf("after tool"));
});

test("工具参数开始流式输出时生成占位行，真实工具吸收参数与起始时间", () => {
	const parent = new Container();
	const assistant = new Container();
	parent.addChild(assistant);
	runtime.lastChatContainer = parent;
	runtime.lastStreamingComp = assistant;
	noteStreamingToolCall([{ type: "toolCall", name: "bash", partialJson: "echo" }], { contentIndex: 0 });
	const placeholder = runtime.preparingByIndex.get(0)!;
	assert.equal(placeholder.toolCallId, "preparing:0");
	const start = runtime.toolStarts.get("preparing:0");
	noteStreamingToolCall([{ type: "toolCall", id: "real", name: "bash", arguments: { command: "echo ok" } }], { contentIndex: 0 });
	assert.equal(runtime.preparingByIndex.size, 1);
	assert.equal(runtime.toolStarts.get("real"), start);
	const real = { toolCallId: "real", toolName: "bash", args: {}, _contentIndex: -1 };
	absorbPreparingTool(real);
	assert.deepEqual(real.args, { command: "echo ok" });
	assert.equal(real._contentIndex, 0);
	assert.equal(runtime.preparingByIndex.size, 0);
	assert.equal(placeholder.owner, null);
});

test("同名并行工具不能通过名称猜测匹配，ID 匹配才吸收", () => {
	for (const index of [0, 1]) noteStreamingToolCall([
		{ type: "toolCall", id: "a", name: "bash" }, { type: "toolCall", id: "b", name: "bash" },
	], { contentIndex: index });
	assert.equal(takePreparingTool({ toolName: "bash" }), undefined);
	assert.equal(runtime.preparingByIndex.size, 2);
	assert.equal(takePreparingTool({ toolCallId: "b", toolName: "bash" })?.toolCallId, "b");
	assert.equal(runtime.preparingByIndex.size, 1);
});

test("工具完成后耗时冻结在结束时间", () => {
	runtime.toolStarts.set("a", 1000);
	assert.equal(toolElapsed({ toolCallId: "a", result: {}, _groupEndAt: 3250 }), "2.3");
});

test("详情窗口展示完整输出，滚动可以从尾部移回开头", () => {
	const modal = new DetailModalComponent({ kind: "tool", tool: tool("a", { content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n") }] }) });
	try {
		assert.ok(modal.render(70).join("\n").includes("line-39"));
		modal.scrollTo(0);
		assert.ok(modal.render(70).join("\n").includes("line-0"));
		assert.equal(modal.handleInput("unhandled"), false);
	} finally { modal.dispose(); }
});

test("检查选择器默认选择最后一项，向上移动后更新不抢回焦点", () => {
	const group = new ToolGroupComponent();
	group.addThinking(thinking("first"));
	group.addThinking(thinking("last"));
	runtime.groups.add(group);
	const selector = new InspectSelectorModal();
	assert.ok(selector.render(70).join("\n").includes("[2/2]"));
	selector.handleInput("k");
	group.addThinking(thinking("new"));
	selector.refreshEntries();
	assert.ok(selector.render(70).join("\n").includes("[1/3]"));
});
