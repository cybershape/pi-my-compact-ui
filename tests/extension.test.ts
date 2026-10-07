import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import extension from "../index.js";
import { createRuntimeState, runtime } from "../src/state.js";
import { ToolGroupComponent } from "../src/tool-group.js";
import { getAssistantContentState, ensureHistoricalThinkingAnchors, installNativeThinkingSuppression } from "../src/assistant-patches.js";
import { installGrouping } from "../src/grouping.js";
import { isMarkdown } from "../src/guards.js";

const handlers = new Map<string, (event: any, ctx?: any) => Promise<void>>();
const commands = new Map<string, any>();
const api = {
	on(name: string, handler: (event: any, ctx?: any) => Promise<void>) { handlers.set(name, handler); },
	registerCommand(name: string, command: any) { commands.set(name, command); },
} as unknown as ExtensionAPI;

beforeEach(() => {
	Object.assign(runtime, createRuntimeState());
	handlers.clear();
	commands.clear();
	extension(api);
});
afterEach(() => {
	if (runtime.animTimer) clearTimeout(runtime.animTimer);
	runtime.activeModalComponent?.dispose();
});

async function emit(name: string, event: any = {}) {
	const handler = handlers.get(name);
	assert.ok(handler, `missing handler ${name}`);
	await handler(event);
}
function message(content: any[], reasoning?: number): any {
	return { role: "assistant", content, usage: { reasoning } };
}
async function update(content: any[], type: string, contentIndex: number, reasoning?: number) {
	await emit("message_update", { message: message(content, reasoning), assistantMessageEvent: { type, contentIndex } });
}
function mountLiveAssistant() {
	const parent = new Container();
	const assistant = new AssistantMessageComponent();
	(assistant as any).isStreaming = true;
	parent.addChild(assistant);
	return { parent, assistant, content: (assistant as any).contentContainer as Container };
}

test("无 UI 模式下配置命令只通知，不打开编辑器", async () => {
	const notifications: string[] = [];
	await commands.get("compact-ui-config").handler("", {
		hasUI: false,
		ui: {
			notify(text: string) { notifications.push(text); },
			custom() { assert.fail("不应打开 TUI"); },
		},
	});
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]!.includes("maxGroupEntries="));
});

test("session_start 捕获 TUI，Tab 不触发弹窗，扩展 Ctrl+I 可以打开并关闭选择器", async () => {
	let input: ((data: string) => any) | undefined;
	let hidden = 0;
	const tui = {
		requestRender() {},
		showOverlay() { return { hide() { hidden++; } }; },
	};
	await handlers.get("session_start")!({}, {
		ui: {
			theme: {},
			setHiddenThinkingLabel(label: string) { assert.equal(label, ""); },
			onTerminalInput(handler: (data: string) => any) { input = handler; },
			setWidget(_name: string, factory: (tui: any) => any) { factory(tui); },
		},
	});
	assert.equal(runtime.capturedTui, tui);
	assert.equal(input!("\t"), undefined);
	assert.equal(runtime.activeSelectorHandle, null);
	assert.deepEqual(input!("\x1b[105;5u"), { consume: true });
	assert.ok(runtime.activeSelectorHandle);
	assert.deepEqual(input!("\x1b[105;5:3u"), { consume: true });
	assert.deepEqual(input!("\x1b"), { consume: true });
	assert.equal(runtime.activeSelectorHandle, null);
	assert.equal(hidden, 1);
});

test("扩展保持命令和关键事件注册", () => {
	assert.ok(commands.has("compact-inspect"));
	assert.ok(commands.has("compact-ui-config"));
	for (const name of ["session_start", "session_shutdown", "agent_start", "turn_start", "turn_end", "message_start", "message_update", "message_end", "agent_end", "tool_execution_start", "tool_execution_end"]) assert.ok(handlers.has(name));
});

test("流式思考、工具、正文保持顺序，迟到的 thinking_end 不产生重复行", async () => {
	await emit("message_start", { message: { role: "user" } });
	await emit("message_start", { message: { role: "assistant" } });
	const { parent, assistant, content } = mountLiveAssistant();
	const blocks = [{ type: "thinking", thinking: "plan" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "a.ts" } }];
	await update(blocks, "thinking_start", 0);
	await update(blocks, "thinking_end", 0);
	await update(blocks, "toolcall_start", 1);
	const group = runtime.lastActiveGroup!;
	assert.deepEqual(group.entries.map((item) => item.kind), ["thinking", "tool"]);
	const withText = [...blocks, { type: "text", text: "answer" }];
	assistant.updateContent(message(withText), true);
	await update(withText, "text_delta", 2);
	assert.equal(group.sealed, true);
	assert.equal(group.anchored, true);
	assert.ok(!parent.children.includes(group));
	assert.equal(content.children.filter((child) => child === group).length, 1);
	assert.ok(content.children.indexOf(group) < content.children.findIndex(isMarkdown));
	await update(withText, "thinking_end", 0);
	assert.equal(group.entries.filter((item) => item.kind === "thinking").length, 1);
	await update(withText, "done", 0, 123);
	const entry = group.entries[0]!;
	assert.equal(entry.kind === "thinking" && entry.tokens, 123);
	assert.equal(withText[0]?.type, "thinking", "presentation patch must not mutate source messages");
});

test("累积正文更新不重复封组，组件重建保留唯一锚点与确定性间距", async () => {
	await emit("message_start", { message: { role: "assistant" } });
	const { assistant, content } = mountLiveAssistant();
	const blocks = [{ type: "thinking", thinking: "plan" }, { type: "text", text: "answer" }];
	await update(blocks, "thinking_start", 0);
	assistant.updateContent(message(blocks), true);
	await update(blocks, "text_delta", 1);
	const group = runtime.lastActiveGroup!;
	assistant.updateContent(message([...blocks.slice(0, 1), { type: "text", text: "answer extended" }]), true);
	await update(blocks, "text_delta", 1);
	assert.equal(content.children.filter((child) => child === group).length, 1);
	assert.equal(getAssistantContentState(content).anchors.size, 1);
	const index = content.children.indexOf(group);
	assert.ok(content.children[index - 1] instanceof Spacer);
	assert.ok(content.children[index + 1] instanceof Spacer);
	assert.ok(isMarkdown(content.children[index + 2]));
});

test("assistant Markdown keeps its native theme and renderer", () => {
	const customTheme = {} as any;
	const assistant = new AssistantMessageComponent(message([
		{ type: "thinking", thinking: "plan" },
		{ type: "text", text: "```ts\nconst answer = 42;\n```" },
	]), false, customTheme);
	const content = (assistant as any).contentContainer as Container;
	const markdown = content.children.find(isMarkdown) as any;
	assert.ok(markdown);
	assert.equal(markdown.theme, customTheme);
	assert.equal(Object.hasOwn(markdown, "render"), false);
	assert.equal(Object.hasOwn(assistant, "setExpanded"), false);
	assert.equal(content.children.filter((child) => child instanceof ToolGroupComponent).length, 1);
});

test("同一 assistant 多个思考段各自独立，消息切换不继承 reasoning usage", async () => {
	await emit("message_start", { message: { role: "assistant" } });
	mountLiveAssistant();
	const blocks = [{ type: "thinking", thinking: "one" }, { type: "thinking", thinking: "two" }];
	await update(blocks, "thinking_start", 0);
	await update(blocks, "thinking_end", 0, 20);
	await update(blocks, "thinking_start", 1);
	await update(blocks, "thinking_end", 1);
	assert.equal(runtime.lastActiveGroup!.entries.length, 2);
	assert.notEqual(runtime.lastActiveGroup!.entries[0], runtime.lastActiveGroup!.entries[1]);
	await emit("message_start", { message: { role: "assistant" } });
	assert.equal(runtime.lastReportedReasoningTokens, 0);
	assert.equal(runtime.lastSealedThinkingEntry, null);
	assert.equal(runtime.sealedThinkingIndexes.size, 0);
});

test("思考先于组件到达时暂存，挂载后仅添加一次", async () => {
	await emit("message_start", { message: { role: "assistant" } });
	await update([{ type: "thinking", thinking: "early" }], "thinking_start", 0);
	assert.equal(runtime.unattachedThinking.length, 1);
	assert.equal(runtime.groups.size, 0);
	mountLiveAssistant();
	assert.equal(runtime.unattachedThinking.length, 0);
	assert.equal(runtime.lastActiveGroup!.entries.length, 1);
});

test("新用户消息与 agent_end 清理流式状态和空占位组", async () => {
	await emit("message_start", { message: { role: "assistant" } });
	mountLiveAssistant();
	await update([{ type: "thinking", thinking: "" }], "thinking_start", 0);
	await emit("agent_end");
	assert.equal(runtime.groups.size, 0);
	assert.equal(runtime.activeThinking, null);
	assert.equal(runtime.preparingByIndex.size, 0);
	await emit("message_start", { message: { role: "user" } });
	assert.equal(runtime.lastStreamingComp, null);
	assert.equal(runtime.pendingTextSeal, false);
});

test("open groups track tool completion, response waiting, thinking, and subsequent output", async () => {
	await emit("agent_start");
	await emit("turn_start");
	await emit("message_start", { message: { role: "user" } });
	assert.equal(runtime.agentWorkPhase, "waiting-response");
	await emit("message_start", { message: { role: "assistant" } });
	mountLiveAssistant();
	const blocks = [
		{ type: "thinking", thinking: "first plan" },
		{ type: "toolCall", id: "work-call", name: "read", arguments: { path: "a.ts" } },
	];
	await update(blocks, "thinking_start", 0);
	await update(blocks, "thinking_end", 0);
	const group = runtime.lastActiveGroup!;
	assert.ok(group.render(80).join("\n").includes("waiting for next output..."));
	await update(blocks, "toolcall_start", 1);
	assert.ok(group.render(80).join("\n").includes("tool call receiving..."));
	const call = { toolName: "read", toolCallId: "work-call", args: { path: "a.ts" }, result: undefined as unknown };
	group.addTool(call);
	assert.ok(group.render(80).join("\n").includes("tool call receiving..."));
	await update(blocks, "toolcall_delta", 1);
	assert.ok(group.render(80).join("\n").includes("tool call receiving..."));
	await update(blocks, "toolcall_end", 1);
	assert.ok(group.render(80).join("\n").includes("tool calling..."));
	await emit("message_end", { message: message(blocks) });
	await emit("tool_execution_start", { toolCallId: call.toolCallId });
	assert.ok(group.render(80).join("\n").includes("tool calling..."));
	call.result = { content: [] };
	await emit("tool_execution_end", { toolCallId: call.toolCallId });
	assert.ok(group.render(80).join("\n").includes("working..."));
	assert.equal(group.sealed, false);
	assert.equal(group.needsAnimation(), true);
	await emit("turn_end");
	await emit("turn_start");
	assert.ok(group.render(80).join("\n").includes("waiting for response..."));
	await emit("message_start", { message: { role: "assistant" } });
	mountLiveAssistant();
	assert.ok(group.render(80).join("\n").includes("waiting for response..."));
	const nextBlocks = [{ type: "thinking", thinking: "" }];
	await update(nextBlocks, "thinking_start", 0);
	assert.ok(group.render(80).join("\n").includes("waiting for first token..."));
	nextBlocks[0]!.thinking = "next plan";
	await update(nextBlocks, "thinking_delta", 0);
	assert.ok(group.render(80).join("\n").includes("thinking..."));
	await update(nextBlocks, "thinking_end", 0);
	assert.ok(group.render(80).join("\n").includes("waiting for next output..."));
	await emit("message_end", { message: message(nextBlocks, 40) });
	assert.ok(group.render(80).join("\n").includes("working..."));
	assert.equal(runtime.activeThinking, null);
	await emit("agent_end");
	assert.equal(runtime.agentWorkPhase, null);
	assert.equal(group.sealed, true);
	assert.equal(group.needsAnimation(), false);
	assert.ok(group.render(80).join("\n").includes("done"));
	assert.ok(!group.render(80).join("\n").includes("working..."));
});

test("thinking-only groups wait for subsequent output instead of another first token", async () => {
	await emit("agent_start");
	await emit("message_start", { message: { role: "assistant" } });
	mountLiveAssistant();
	const blocks = [{ type: "thinking", thinking: "plan" }];
	await update(blocks, "thinking_start", 0);
	await update(blocks, "thinking_end", 0);
	const group = runtime.lastActiveGroup!;
	const rows = group.render(80).join("\n");
	assert.ok(rows.includes("waiting for next output..."));
	assert.ok(!rows.includes("waiting for first token..."));
	assert.equal(group.needsAnimation(), true);
	await emit("message_end", { message: message(blocks) });
	assert.ok(group.render(80).join("\n").includes("working..."));
	await emit("turn_start");
	assert.ok(group.render(80).join("\n").includes("waiting for response..."));
});

test("message_end finalizes unfinished thinking and enters generic work", async () => {
	await emit("message_start", { message: { role: "assistant" } });
	mountLiveAssistant();
	const blocks = [{ type: "thinking", thinking: "unfinished plan" }];
	await update(blocks, "thinking_start", 0);
	const entry = runtime.activeThinking!;
	await emit("message_end", { message: message(blocks, 75) });
	assert.equal(entry.active, false);
	assert.equal(entry.tokens, 75);
	assert.equal(runtime.activeThinking, null);
	assert.ok(runtime.lastActiveGroup!.render(80).join("\n").includes("working..."));
	await emit("message_end", { message: { role: "toolResult" } });
	assert.equal(runtime.agentWorkPhase, "working");
});

test("text seals the group without adding a response-generation state", async () => {
	await emit("agent_start");
	await emit("message_start", { message: { role: "assistant" } });
	const { assistant } = mountLiveAssistant();
	const blocks = [
		{ type: "thinking", thinking: "first" },
		{ type: "thinking", thinking: "second" },
	];
	await update(blocks, "thinking_start", 0);
	await update(blocks, "thinking_end", 0);
	await update(blocks, "thinking_start", 1);
	await update(blocks, "thinking_end", 1);
	const group = runtime.lastActiveGroup!;
	const withText = [...blocks, { type: "text", text: "answer" }];
	assistant.updateContent(message(withText), true);
	await update(withText, "text_delta", 2);
	assert.equal(group.sealed, true);
	assert.equal(group.needsAnimation(), false);
	const completedRows = group.render(80);
	assert.ok(!completedRows.join("\n").includes("waiting"));
	assert.ok(!completedRows.join("\n").includes("generating response"));
	await update(withText, "thinking_end", 1);
	assert.equal(runtime.agentWorkPhase, "working");
	await emit("turn_start");
	assert.deepEqual(group.render(80), completedRows);
});

test("stream errors and shutdown clear stale waiting states", async () => {
	await emit("message_start", { message: { role: "assistant" } });
	mountLiveAssistant();
	const blocks = [{ type: "thinking", thinking: "plan" }];
	await update(blocks, "thinking_start", 0);
	await update(blocks, "thinking_end", 0);
	await update(blocks, "error", 0);
	assert.ok(runtime.lastActiveGroup!.render(80).join("\n").includes("working..."));
	await emit("session_shutdown");
	assert.equal(runtime.agentWorkPhase, null);
});

test("历史消息按正文 ordinal 重建思考锚点，重复重建幂等", () => {
	const content = new Container();
	const historical = message([
		{ type: "thinking", thinking: "first" }, { type: "text", text: "a" },
		{ type: "thinking", thinking: "second" }, { type: "text", text: "b" },
	], 42);
	ensureHistoricalThinkingAnchors(content, historical);
	ensureHistoricalThinkingAnchors(content, historical);
	const anchors = getAssistantContentState(content).anchors;
	assert.deepEqual([...anchors.keys()], [0, 1]);
	assert.equal(runtime.groups.size, 2);
	assert.equal(anchors.get(0)!.entries[0]!.kind, "thinking");
	assert.ok([...anchors.values()].every((group) => group.sealed && group.anchored));
});

test("历史 thinking-only 消息显示 compact 组，带工具的历史思考不重复附加", () => {
	const historical = new AssistantMessageComponent(message([{ type: "thinking", thinking: "history only" }]));
	const content = (historical as any).contentContainer as Container;
	assert.equal(content.children.filter((child) => child instanceof ToolGroupComponent).length, 1);
	assert.equal(content.children.filter(isMarkdown).length, 0);
	const withTools = new AssistantMessageComponent(message([
		{ type: "thinking", thinking: "tool plan" }, { type: "toolCall", id: "t", name: "bash" },
	]));
	assert.equal((withTools as any).contentContainer.children.filter((child: unknown) => child instanceof ToolGroupComponent).length, 0);
});

test("热重载替换分组补丁而不是叠加，不重复显示历史思考", () => {
	installGrouping();
	installGrouping();
	installNativeThinkingSuppression();
	installNativeThinkingSuppression();
	const component = new AssistantMessageComponent(message([
		{ type: "thinking", thinking: "reload" }, { type: "text", text: "answer" },
	]));
	const content = (component as any).contentContainer as Container;
	assert.equal(content.children.filter((child) => child instanceof ToolGroupComponent).length, 1);
	assert.equal(runtime.groups.size, 1);
});
