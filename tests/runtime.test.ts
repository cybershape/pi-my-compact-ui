import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Container, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createRuntimeState, runtime } from "../src/state.js";
import { ToolGroupComponent } from "../src/tool-group.js";
import { createThinkingEntry, finalizeActiveThinking, refreshSealedThinkingTokens, updateActiveThinkingTokens } from "../src/thinking.js";
import { absorbPreparingTool, noteStreamingToolCall, takePreparingTool, toolElapsed, loadSessionToolTimings } from "../src/streaming-tools.js";
import { PARENT_KEY } from "../src/constants.js";
import { DetailModalComponent, InspectSelectorModal, openInspectSelectorModal, closeDetailModal, closeInspectSelectorModal } from "../src/modals.js";
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

test("groups stay collapsed, preserve order, and respect rendering width", () => {
	const group = new ToolGroupComponent();
	const call = { ...tool("a", { content: [{ type: "text", text: "result body" }] }),
		setExpanded() { assert.fail("native tools must not be expanded"); },
	};
	group.addTool(call);
	const collapsed = group.render(60);
	assert.ok(!collapsed.join("\n").includes("tools done"));
	assert.ok(!collapsed.join("\n").includes("result body"));
	group.setExpanded(true);
	assert.deepEqual(group.render(60), collapsed);
	for (const width of [1, 8, 20, 80]) assert.ok(group.render(width).every((line) => visibleWidth(line) <= width));
	group.addThinking(thinking("after tool"));
	group.setExpanded(false);
	const rows = group.render(60).join("\n");
	assert.ok(rows.includes("done"));
	assert.ok(!rows.includes("tools and thinking done"));
	assert.ok(rows.indexOf("bash") < rows.indexOf("after tool"));
});

test("group 标题状态覆盖：tool calling、thinking、waiting for first token 以及完成状态 done", () => {
	const group = new ToolGroupComponent();
	const runningTool: any = {
		toolName: "bash",
		toolCallId: "run_1",
		args: { command: "sleep 1" },
		isPartial: true,
		executionStarted: true,
		render: () => ["native"],
		invalidate() {},
	};
	const doneTool = {
		toolName: "read",
		toolCallId: "read_1",
		args: { path: "a.ts" },
		result: { content: [] },
		render: () => ["native"],
		invalidate() {},
	};

	group.addTool(runningTool);
	group.addTool(doneTool);

	// 1. 存在未完成工具：tool calling...
	assert.ok(group.render(80).join("\n").includes("tool calling..."));

	// 2. 工具均已完成，且进入尚无 token 内容的流式思考：waiting for first token
	runningTool.isPartial = false;
	runningTool.result = { content: [] };
	const activeThinking: ThinkingEntry = {
		kind: "thinking",
		id: 99,
		text: "",
		tokens: 0,
		tokensExact: false,
		active: true,
		owner: null,
	};
	group.addThinking(activeThinking);
	assert.ok(group.render(80).join("\n").includes("waiting for first token"));

	// 3. 流式思考收到首批 token 内容：thinking...
	activeThinking.text = "analyzing problem";
	activeThinking.tokens = 5;
	assert.ok(group.render(80).join("\n").includes("thinking..."));

	// 4. 无工具的纯思考组在首个 token 到达前：waiting for first token
	const thinkingGroup = new ToolGroupComponent();
	const previousDoneThinking: ThinkingEntry = {
		kind: "thinking",
		id: 100,
		text: "earlier step",
		tokens: 10,
		tokensExact: true,
		active: false,
		owner: null,
	};
	const earlyThinking: ThinkingEntry = {
		kind: "thinking",
		id: 101,
		text: "",
		tokens: 0,
		tokensExact: false,
		active: true,
		owner: null,
	};
	thinkingGroup.addThinking(previousDoneThinking);
	thinkingGroup.addThinking(earlyThinking);
	assert.ok(thinkingGroup.render(80).join("\n").includes("waiting for first token"));

	// 5. 封组完成且同时包含工具与思考：done
	activeThinking.active = false;
	activeThinking.text = "done analyzing";
	group.sealed = true;
	const finishedRows = group.render(80).join("\n");
	assert.ok(finishedRows.includes("done"));
	assert.ok(!finishedRows.includes("tools and thinking done"));

	// 6. 封组完成且仅包含工具：tools done
	const toolOnlyGroup = new ToolGroupComponent();
	toolOnlyGroup.addTool(doneTool);
	toolOnlyGroup.addTool({ ...doneTool, toolCallId: "read_2" });
	toolOnlyGroup.sealed = true;
	assert.ok(toolOnlyGroup.render(80).join("\n").includes("tools done"));
});

test("思考超长时使用 '...' 截断，与右侧信息之间保持单个空格且颜色与文本一致", () => {
	const group = new ToolGroupComponent();
	group.addThinking(thinking("We are analyzing the code thoroughly to find the best way to solve this issue."));

	runtime.currentTheme = {
		fg: (c: string, t: string) => `\x1b[38;5;${c === "thinkingText" ? 244 : 250}m${t}\x1b[39m`,
	};

	const rendered = group.render(60).join("\n");
	const plain = stripTerminalSequences(rendered);
	assert.ok(plain.includes("... ("));
	assert.ok(!plain.includes("...  ("));
	assert.ok(!rendered.includes("…"));
	// 省略号应该与 thinkingText 同色
	assert.ok(rendered.includes("\x1b[38;5;244m...\x1b[39m"));

	runtime.currentTheme = null;
});

test("工具行超长时按整行宽度截断到耗时前，且省略号使用 '...' 与耗时保持单个空格", () => {
	const group = new ToolGroupComponent();
	group.addTool({
		toolName: "bash",
		toolCallId: "call_long",
		args: { command: "git commit -m 'feat: limit group entries with hidden count and dimming, update thinking ellipsis'" },
		result: { content: [] },
		render: () => ["native"],
		invalidate() {},
	});

	runtime.currentTheme = {
		fg: (c: string, t: string) => `\x1b[38;5;${c === "dim" ? 244 : 250}m${t}\x1b[39m`,
	};

	const rendered = group.render(80).join("\n");
	const plain = stripTerminalSequences(rendered);
	assert.ok(plain.includes("... ("));
	assert.ok(!plain.includes("...  ("));
	assert.ok(!rendered.includes("…"));
	assert.ok(rendered.includes("\x1b[38;5;244m...\x1b[39m"));

	runtime.currentTheme = null;
});

test("组内条数超过上限时，标题显示 (N hidden)，最上面一条使用较浅颜色渲染", () => {
	const group = new ToolGroupComponent();
	// 添加 7 个条目，默认上限为 5
	for (let i = 1; i <= 7; i++) {
		group.addTool({
			toolName: `cmd_${i}`,
			toolCallId: `call_${i}`,
			args: {},
			result: { content: [] },
			render: () => ["native"],
			invalidate() {},
		});
	}

	runtime.currentTheme = {
		fg: (c: string, t: string) => `[${c}]${t}[/${c}]`,
		bold: (t: string) => `<b>${t}</b>`,
	};

	const rendered = group.render(80);
	const text = rendered.join("\n");

	// 标题应包含 (2 hidden)
	assert.ok(text.includes("(2 hidden)"));

	// 较早的 cmd_1 与 cmd_2 应被隐藏
	assert.ok(!text.includes("cmd_1"));
	assert.ok(!text.includes("cmd_2"));

	// 剩余的 5 个条目应该出现
	assert.ok(text.includes("cmd_3"));
	assert.ok(text.includes("cmd_7"));

	// 最上面一条 (cmd_3) 应使用较浅颜色 (dim) 渲染名称，而非粗体 toolTitle
	assert.ok(text.includes("[dim]cmd_3[/dim]"));
	// 后续条目 (如 cmd_4) 应正常使用 toolTitle 与加粗
	assert.ok(text.includes("[toolTitle]<b>cmd_4</b>[/toolTitle]"));

	// 若首条可见项为 thinking，也应使用较浅颜色
	const groupWithThinking = new ToolGroupComponent();
	groupWithThinking.addTool(tool("c1"));
	groupWithThinking.addThinking(thinking("top thinking"));
	for (let i = 2; i <= 5; i++) {
		groupWithThinking.addTool(tool(`c${i}`));
	}
	const textThinking = groupWithThinking.render(80).join("\n");
	assert.ok(textThinking.includes("(1 hidden)"));
	assert.ok(textThinking.includes("[dim]thinking[/dim]"));

	runtime.currentTheme = null;
});

test("组内条数未超上限时，不显示 hidden 标记且首条保持正常颜色", () => {
	const group = new ToolGroupComponent();
	for (let i = 1; i <= 3; i++) {
		group.addTool({
			toolName: `cmd_${i}`,
			toolCallId: `call_${i}`,
			args: {},
			result: { content: [] },
			render: () => ["native"],
			invalidate() {},
		});
	}

	runtime.currentTheme = {
		fg: (c: string, t: string) => `[${c}]${t}[/${c}]`,
		bold: (t: string) => `<b>${t}</b>`,
	};

	const rendered = group.render(80);
	const text = rendered.join("\n");

	assert.ok(!text.includes("hidden"));
	assert.ok(text.includes("cmd_1"));
	assert.ok(text.includes("[toolTitle]<b>cmd_1</b>[/toolTitle]"));

	runtime.currentTheme = null;
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
	assert.equal(toolElapsed({ toolCallId: "a", result: {}, _groupEndAt: 3250 }), "2.25s");
});

test("工具执行时间小于 1 秒时显示 ms 且不带小数点，1 至 10 秒显示两位小数，10 秒以上显示一位小数", () => {
	runtime.toolStarts.set("short_1", 1000);
	assert.equal(toolElapsed({ toolCallId: "short_1", result: {}, _groupEndAt: 1045 }), "45ms");

	runtime.toolStarts.set("short_2", 1000);
	assert.equal(toolElapsed({ toolCallId: "short_2", result: {}, _groupEndAt: 1500 }), "500ms");

	runtime.toolStarts.set("short_3", 1000);
	assert.equal(toolElapsed({ toolCallId: "short_3", result: {}, _groupEndAt: 1999 }), "999ms");

	runtime.toolStarts.set("exact_1s", 1000);
	assert.equal(toolElapsed({ toolCallId: "exact_1s", result: {}, _groupEndAt: 2000 }), "1.00s");

	runtime.toolStarts.set("mid_sec", 1000);
	assert.equal(toolElapsed({ toolCallId: "mid_sec", result: {}, _groupEndAt: 3350 }), "2.35s");

	runtime.toolStarts.set("long_sec", 1000);
	assert.equal(toolElapsed({ toolCallId: "long_sec", result: {}, _groupEndAt: 11500 }), "10.5s");

	const group = new ToolGroupComponent();
	group.addTool({
		toolName: "bash",
		toolCallId: "short_1",
		args: { command: "echo fast" },
		result: { content: [] },
		_groupEndAt: 1045,
		render: () => ["native"],
		invalidate() {},
	});

	const rendered = group.render(80).join("\n");
	const plain = stripTerminalSequences(rendered);
	assert.ok(plain.includes("(45ms)"));
	assert.ok(!plain.includes("(45.0ms)"));
	assert.ok(!plain.includes("(0.0s)"));
});

test("历史会话条目恢复真实工具耗时，且已完成工具不再随 Date.now 刷新递增", () => {
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				timestamp: 10000,
				content: [{ type: "toolCall", id: "call_hist", name: "bash", arguments: { command: "ls" } }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call_hist",
				toolName: "bash",
				timestamp: 14200,
				content: [{ type: "text", text: "file.txt" }],
			},
		},
	];

	loadSessionToolTimings(entries);
	assert.equal(runtime.toolStarts.get("call_hist"), 10000);
	assert.equal(runtime.toolDurations.get("call_hist"), 4.2);

	const histTool = { toolCallId: "call_hist", result: { content: [] } };
	assert.equal(toolElapsed(histTool), "4.20s");

	// 再次调用耗时保持稳定，不随当前时间递增
	assert.equal(toolElapsed(histTool), "4.20s");

	// 若工具已有 result 但无历史时间记录，冻结在 0ms，绝不使用 Date.now 计时
	const unknownTool = { toolCallId: "unknown", result: { content: [] } };
	assert.equal(toolElapsed(unknownTool), "0ms");
	assert.equal(toolElapsed(unknownTool), "0ms");
});

test("封组后的历史组 needsAnimation 为 false，避免后台死循环刷新", () => {
	const group = new ToolGroupComponent();
	group.addTool({ toolCallId: "t1", toolName: "bash", result: {} });
	group.sealed = true;
	assert.equal(group.needsAnimation(), false);
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

test("检查选择器高度按条目数与 70% 上限动态展开，不受 16 行硬编码限制", () => {
	const group = new ToolGroupComponent();
	for (let i = 0; i < 40; i++) {
		group.addThinking(thinking(`item-${i}`));
	}
	runtime.groups.add(group);

	runtime.capturedTui = {
		terminal: { rows: 50, columns: 100 },
	};

	const selector = new InspectSelectorModal();
	const lines = selector.render(70);
	// 50 行终端的 70% 为 35 行
	assert.equal(lines.length, 35);

	runtime.capturedTui = null;
});

test("在选择器中按回车弹出详情层时保留选择器层，关闭详情层后返回选择器", () => {
	const group = new ToolGroupComponent();
	group.addThinking(thinking("entry 1"));
	group.addThinking(thinking("entry 2"));
	runtime.groups.add(group);

	let overlayStack: any[] = [];
	runtime.capturedTui = {
		terminal: { rows: 40, columns: 80 },
		requestRender() {},
		showOverlay(component: any, options: any) {
			const handle = {
				component,
				options,
				hide() {
					overlayStack = overlayStack.filter((h) => h !== handle);
				},
			};
			overlayStack.push(handle);
			return handle;
		},
	};

	openInspectSelectorModal();
	assert.equal(overlayStack.length, 1);
	assert.ok(runtime.activeSelectorHandle);

	runtime.activeSelectorComponent!.handleInput("\r");
	assert.equal(overlayStack.length, 2);
	assert.ok(runtime.activeSelectorHandle);
	assert.ok(runtime.activeModalHandle);

	closeDetailModal();
	assert.equal(overlayStack.length, 1);
	assert.ok(runtime.activeSelectorHandle);
	assert.equal(runtime.activeModalHandle, null);

	closeInspectSelectorModal();
	assert.equal(overlayStack.length, 0);
	assert.equal(runtime.activeSelectorHandle, null);

	runtime.capturedTui = null;
});
