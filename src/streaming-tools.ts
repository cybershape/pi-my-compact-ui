/** 在参数流式输出阶段创建工具占位行，并迁移到真实工具组件。 */
import { runtime } from "./state.js";
import { PARENT_KEY } from "./constants.js";
import { isToolGroup } from "./guards.js";
import { ToolGroupComponent } from "./tool-group.js";
import { detachGroup, noteGroupMount } from "./assistant-patches.js";
import type { PreparingTool } from "./types.js";
import { locateStreamingToolCall, streamingToolArgs } from "./helpers.js";

export function toolElapsed(tool: any): string {
	const start = runtime.toolStarts.get(tool.toolCallId) ?? Date.now();
	const end = tool?.result ? tool._groupEndAt ?? Date.now() : Date.now();
	return ((end - start) / 1000).toFixed(1);
}

export function rememberToolStart(toolCallId: string): void {
	if (!toolCallId || runtime.toolStarts.has(toolCallId)) return;
	runtime.toolStarts.set(toolCallId, Date.now());
}

export function findGroupedTool(toolCallId: string, contentIndex: number): any | undefined {
	for (const group of runtime.groups) {
		for (const entry of group.entries) {
			if (entry.kind !== "tool") continue;
			const tool = entry.tool;
			if (toolCallId && tool?.toolCallId === toolCallId) return tool;
			if (tool?._contentIndex === contentIndex) return tool;
		}
	}
	return undefined;
}

export function invalidateGroupedTool(tool: any): void {
	const group = tool?.owner ?? tool?.[PARENT_KEY];
	if (isToolGroup(group)) {
		if (!group.sealed) runtime.lastActiveGroup = group;
		group.invalidate();
	} else {
		runtime.lastActiveGroup?.invalidate();
	}
	runtime.capturedTui?.requestRender?.();
}

export function findOpenGroup(): ToolGroupComponent | null {
	if (runtime.lastActiveGroup && !runtime.lastActiveGroup.sealed && runtime.groups.has(runtime.lastActiveGroup)) return runtime.lastActiveGroup;
	for (const group of runtime.groups) {
		if (!group.sealed) return group;
	}
	return null;
}

export function placeGroupAfter(parent: any, after: any, group: ToolGroupComponent): void {
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	detachGroup(group, parent);
	const existing = children.indexOf(group);
	if (existing >= 0) children.splice(existing, 1);
	const afterIndex = after ? children.indexOf(after) : -1;
	children.splice(afterIndex >= 0 ? afterIndex + 1 : children.length, 0, group);
	noteGroupMount(parent, group);
	runtime.lastActiveGroup = group;
}

export function openToolGroup(): ToolGroupComponent | null {
	const open = findOpenGroup();
	if (open) {
		if (runtime.lastChatContainer && runtime.lastStreamingComp) placeGroupAfter(runtime.lastChatContainer, runtime.lastStreamingComp, open);
		return open;
	}
	if (!runtime.lastChatContainer || !runtime.lastStreamingComp) return null;
	let group: ToolGroupComponent;
	const parent = runtime.lastChatContainer;
	const children = parent.children;
	if (!Array.isArray(children)) return null;
	const idx = children.indexOf(runtime.lastStreamingComp);
	group = new ToolGroupComponent();
	detachGroup(group);
	children.splice(idx >= 0 ? idx + 1 : children.length, 0, group);
	noteGroupMount(parent, group);
	runtime.groups.add(group);
	runtime.lastActiveGroup = group;
	parent.invalidate?.();
	return group;
}

export function attachPreparingTool(tool: PreparingTool): void {
	if (tool.owner) return;
	const group = openToolGroup();
	if (!group) return;
	tool.owner = group;
	group.entries.push({ kind: "tool", tool });
	group.invalidate();
	runtime.lastActiveGroup = group;
}

export function detachPreparingTool(tool: PreparingTool): void {
	const group = tool.owner;
	if (group) {
		const index = group.entries.findIndex((entry) => entry.kind === "tool" && entry.tool === tool);
		if (index >= 0) group.entries.splice(index, 1);
	}
	tool.owner = null;
}

export function takePreparingTool(real: any): PreparingTool | undefined {
	const id = String(real?.toolCallId ?? "");
	const name = String(real?.toolName ?? "");
	if (id) {
		for (const [index, candidate] of runtime.preparingByIndex) {
			if (candidate.toolCallId === id) {
				runtime.preparingByIndex.delete(index);
				return candidate;
			}
		}
	}
	const matches = [...runtime.preparingByIndex.entries()].filter(([, candidate]) => candidate.toolName === name);
	if (matches.length === 1) {
		runtime.preparingByIndex.delete(matches[0][0]);
		return matches[0][1];
	}
	return undefined;
}

export function absorbPreparingTool(real: any): void {
	const preparing = takePreparingTool(real);
	if (!preparing) return;
	const id = String(real?.toolCallId ?? "");
	const start = runtime.toolStarts.get(preparing.toolCallId);
	if (start !== undefined && id && !runtime.toolStarts.has(id)) runtime.toolStarts.set(id, start);
	real._contentIndex = preparing._contentIndex;
	if ((!real.args || Object.keys(real.args).length === 0) && preparing.args) real.args = preparing.args;
	detachPreparingTool(preparing);
}

export function clearPreparingTools(): void {
	for (const tool of runtime.preparingByIndex.values()) detachPreparingTool(tool);
	runtime.preparingByIndex.clear();
}

export function noteStreamingToolCall(content: any[], streamEvent: any): void {
	const located = locateStreamingToolCall(content, streamEvent);
	if (!located) return;
	const { index, block } = located;
	const id = String(block.id || "");
	const name = String(block.name || "tool");
	const args = streamingToolArgs(block);
	const existing = findGroupedTool(id, index);
	if (existing && !existing._preparing) {
		existing._contentIndex = index;
		existing.args = args;
		rememberToolStart(String(existing.toolCallId || id));
		invalidateGroupedTool(existing);
		return;
	}

	let preparing = runtime.preparingByIndex.get(index);
	if (!preparing) {
		preparing = {
			toolName: name,
			toolCallId: id || `preparing:${index}`,
			args,
			isPartial: true,
			_preparing: true,
			_contentIndex: index,
			owner: null,
		};
		runtime.preparingByIndex.set(index, preparing);
		attachPreparingTool(preparing);
	} else {
		if (name && name !== "tool") preparing.toolName = name;
		if (id && preparing.toolCallId !== id) {
			const previous = preparing.toolCallId;
			preparing.toolCallId = id;
			const start = runtime.toolStarts.get(previous);
			if (start !== undefined && !runtime.toolStarts.has(id)) runtime.toolStarts.set(id, start);
		}
		preparing.args = args;
		if (!preparing.owner) attachPreparingTool(preparing);
	}
	rememberToolStart(preparing.toolCallId);
	invalidateGroupedTool(preparing);
}
