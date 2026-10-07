/** 按流顺序组合思考与工具，并在可见正文边界封组。 */
import { isToolExecution, isSpacer, isAssistantMessage, isToolGroup, isContainer } from "./guards.js";
import { ToolGroupComponent } from "./tool-group.js";
import { thinkingAlreadyShown, isVisibleTextMarkdown, anchorGroupBeforeCurrentText, detachGroup, noteGroupMount, removeGroupFromContainer, ensureAssistantThinkingPatched, stripAssistantPhantomPadding, restoreAssistantAnchor, releaseAssistantAnchors, getAssistantContentState } from "./assistant-patches.js";
import { runtime } from "./state.js";
import { estimateTextTokens } from "./helpers.js";
import { findOpenGroup, openToolGroup, placeGroupAfter } from "./streaming-tools.js";
import { finalizeActiveThinking } from "./thinking.js";
import type { ThinkingEntry, NoticeEntry, PatchState } from "./types.js";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { PATCH_KEY, LIVE_ASSISTANT_KEY, IS_STREAMING_COMP, PARENT_KEY } from "./constants.js";

export function isGroupable(value: any): boolean {
	return isToolExecution(value);
}

export function previousGroupable(children: any[], start: number): { child: any; index: number } | undefined {
	for (let i = start; i >= 0; i--) {
		const child = children[i];
		if (isSpacer(child)) continue;
		if (isAssistantMessage(child)) continue;
		// A sealed block is a text boundary, not a reason to ignore an earlier open group.
		// Notices and other chat widgets between tool rounds are not boundaries either.
		if (isToolGroup(child) && child.sealed) continue;
		if (isToolGroup(child) || isGroupable(child)) return { child, index: i };
	}
	return undefined;
}

export function assistantHasVisibleText(component: any): boolean {
	const content = component?.lastMessage?.content;
	if (!Array.isArray(content)) return false;
	return content.some((item: any) => item?.type === "text" && String(item.text ?? "").trim());
}

export function absorbThinkingBeforeText(group: ToolGroupComponent, message: any): void {
	const content = message?.content;
	if (!Array.isArray(content)) return;
	for (const item of content) {
		if (item?.type === "text" && String(item.text ?? "").trim()) break;
		if (item?.type !== "thinking") continue;
		const text = String(item.thinking ?? "").trim();
		if (!text || thinkingAlreadyShown(text)) continue;
		group.entries.push({
			kind: "thinking",
			id: runtime.thinkingEntrySeq++,
			text,
			tokens: estimateTextTokens(text),
			tokensExact: false,
			active: false,
			owner: group,
		});
	}
}

export function sealOpenGroupAtAssistantText(assistant: any): void {
	const open = findOpenGroup();
	if (!open) return;
	absorbThinkingBeforeText(open, assistant.lastMessage);
	open.sealed = true;
	finalizeActiveThinking();
	const contentContainer = assistant.contentContainer;
	if (isContainer(contentContainer) && contentContainer.children.some(isVisibleTextMarkdown)) {
		const previous = runtime.lastStreamingComp;
		runtime.lastStreamingComp = assistant;
		anchorGroupBeforeCurrentText(open, 0);
		runtime.lastStreamingComp = previous ?? assistant;
	}
	open.invalidate();
}

export function ensureThinkingGroup(): void {
	if (runtime.unattachedThinking.length === 0) return;
	let group = findOpenGroup();
	if (group && runtime.lastChatContainer && runtime.lastStreamingComp) {
		placeGroupAfter(runtime.lastChatContainer, runtime.lastStreamingComp, group);
	}
	if (!group) {
		if (!runtime.lastChatContainer || !runtime.lastStreamingComp) return; // retry on the next event
		const parent = runtime.lastChatContainer;
		const children = parent.children;
		if (!Array.isArray(children)) return;
		const idx = children.indexOf(runtime.lastStreamingComp);
		group = new ToolGroupComponent();
		detachGroup(group);
		children.splice(idx >= 0 ? idx + 1 : children.length, 0, group);
		noteGroupMount(parent, group);
		runtime.groups.add(group);
		runtime.lastActiveGroup = group;
		parent.invalidate?.();
	}
	while (runtime.unattachedThinking.length > 0) group.addThinking(runtime.unattachedThinking.shift()!);
	group.invalidate();
	runtime.capturedTui?.requestRender?.();
}

export function flushPendingTextSeal(): void {
	if (!runtime.pendingTextSeal) return;

	// A run still streaming when the answer starts belongs to the block being
	// sealed, and may not have a group yet.
	if (runtime.activeThinking || runtime.unattachedThinking.length > 0) ensureThinkingGroup();

	if (runtime.lastActiveGroup && !runtime.lastActiveGroup.sealed) {
		// The active group contains every thinking/tool event since the previous
		// visible text. Anchor it immediately before this text block so the visual
		// component order matches the stream order:
		//   group -> visible text -> next group -> next visible text
		if (runtime.lastActiveGroup.hasVisibleEntries()) {
			if (runtime.pendingTextOrdinal !== null) {
				anchorGroupBeforeCurrentText(runtime.lastActiveGroup, runtime.pendingTextOrdinal);
			}
		} else {
			if (runtime.lastChatContainer) removeGroupFromContainer(runtime.lastChatContainer, runtime.lastActiveGroup);
			runtime.groups.delete(runtime.lastActiveGroup);
		}
		runtime.lastActiveGroup.sealed = true;
		finalizeActiveThinking();
		runtime.lastActiveGroup.invalidate();
		runtime.pendingTextSeal = false;
		runtime.pendingTextOrdinal = null;
		return;
	}

	// No thinking or tools preceded this text, so there is no compact block to
	// seal. Do not let the boundary leak forward and close a later tool group.
	runtime.pendingTextSeal = false;
	runtime.pendingTextOrdinal = null;
}

export function getPrecedingAssistantThinking(children: any[], beforeIndex: number): string[] {
	for (let i = beforeIndex; i >= 0; i--) {
		const child = children[i];
		if (isSpacer(child)) continue;
		if (isAssistantMessage(child)) {
			const content = (child as any).lastMessage?.content;
			if (!Array.isArray(content)) return [];
			const texts: string[] = [];
			for (const item of content) {
				if (item?.type === "thinking") {
					const t = String(item.thinking ?? "").trim();
					if (t && !thinkingAlreadyShown(t)) texts.push(t);
				}
			}
			return texts;
		}
		break;
	}
	return [];
}

export function attachPrecedingThinkingToGroup(group: ToolGroupComponent, children: any[], beforeIndex: number): void {
	const texts = getPrecedingAssistantThinking(children, beforeIndex);
	if (texts.length === 0) return;
	for (const text of texts) {
		if (thinkingAlreadyShown(text)) continue;
		const entry: ThinkingEntry = {
			kind: "thinking",
			id: runtime.thinkingEntrySeq++,
			text,
			tokens: estimateTextTokens(text),
			tokensExact: false,
			active: false,
			owner: group,
		};
		group.entries.push(entry);
	}
}

export function joinOpenGroup(parent: any, index: number, component: any): boolean {
	if (!runtime.lastChatContainer || parent !== runtime.lastChatContainer) return false;
	const open = findOpenGroup();
	if (!open) return false;
	const children = parent.children;
	children.splice(index, 1);
	if (runtime.lastStreamingComp && children.includes(runtime.lastStreamingComp)) {
		placeGroupAfter(parent, runtime.lastStreamingComp, open);
	} else if (!children.includes(open)) {
		children.push(open);
		noteGroupMount(parent, open);
	}
	attachPrecedingThinkingToGroup(open, children, children.indexOf(open) - 1);
	open.addTool(component);
	runtime.lastActiveGroup = open;
	open.invalidate();
	return true;
}

export function maybeGroup(parent: any, component: any): void {
	if (!isGroupable(component) || isToolGroup(parent)) return;
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index < 0) return;
	if (joinOpenGroup(parent, index, component)) return;
	const prior = previousGroupable(children, index - 1);

	// Previous sibling is an open (not-yet-sealed) group → join it.
	if (isToolGroup(prior?.child) && !prior.child.sealed) {
		attachPrecedingThinkingToGroup(prior.child, children, index - 1);
		children.splice(index, 1);
		prior.child.addTool(component);
		runtime.lastActiveGroup = prior.child;
		return;
	}
	// Previous sibling is a bare tool → merge both into a new group.
	if (prior && isGroupable(prior.child)) {
		const group = new ToolGroupComponent();
		attachPrecedingThinkingToGroup(group, children, prior.index - 1);
		group.addTool(prior.child);
		attachPrecedingThinkingToGroup(group, children, index - 1);
		group.addTool(component);
		(parent as any).children[prior.index] = group;
		children.splice(index, 1);
		noteGroupMount(parent, group);
		runtime.groups.add(group);
		runtime.lastActiveGroup = group;
		return;
	}
	// Otherwise (sealed group before, or nothing groupable) → wrap the tool in a
	// fresh open group so it stays visible.
	const group = new ToolGroupComponent();
	attachPrecedingThinkingToGroup(group, children, index - 1);
	group.addTool(component);
	(parent as any).children[index] = group;
	noteGroupMount(parent, group);
	runtime.groups.add(group);
	runtime.lastActiveGroup = group;
}

export function extractCacheMissNotice(component: any): string | null {
	if (!component || typeof component !== "object") return null;
	let text = "";
	if (typeof component.build === "function") {
		try {
			text = String(component.build());
		} catch {}
	}
	if (!text && typeof component.text === "string") {
		text = component.text;
	}
	if (!text && typeof component.render === "function") {
		try {
			const rendered = component.render(120);
			if (Array.isArray(rendered)) text = rendered.join("\n");
		} catch {}
	}
	if (!text) return null;
	const clean = stripTerminalSequences(text).trim();
	if (/cache miss/i.test(clean) && /re-billed/i.test(clean)) {
		return clean;
	}
	return null;
}

export function absorbCacheMissNotice(parent: any, text: string): boolean {
	if (!runtime.lastChatContainer && parent) {
		runtime.lastChatContainer = parent;
	}
	let group = findOpenGroup();
	if (!group) {
		group = openToolGroup();
	}
	if (!group && runtime.lastActiveGroup && runtime.groups.has(runtime.lastActiveGroup)) {
		group = runtime.lastActiveGroup;
	}
	if (!group) return false;

	const entry: NoticeEntry = {
		kind: "notice",
		id: runtime.noticeEntrySeq++,
		noticeType: "cache_miss",
		text,
		owner: null,
	};
	group.addNotice(entry);
	runtime.lastActiveGroup = group;
	runtime.capturedTui?.requestRender?.();
	return true;
}

export function installGrouping(): void {
	const host = globalThis as any;
	const prototypes: any[] = [Container.prototype];
	const agentContainerProto = Object.getPrototypeOf(AssistantMessageComponent.prototype);
	if (agentContainerProto && agentContainerProto !== Object.prototype && !prototypes.includes(agentContainerProto)) {
		prototypes.push(agentContainerProto);
	}

	const patchKey = PATCH_KEY;
	const previous = host[patchKey] as Map<any, PatchState> | undefined;
	const stateMap = new Map<any, PatchState>();

	for (const prototype of prototypes) {
		const prev = previous instanceof Map ? previous.get(prototype) : (previous as any as PatchState | undefined);
		const original = {
			addChild: prev && prototype.addChild === prev.installed.addChild ? prev.original.addChild : prototype.addChild,
			removeChild: prev && prototype.removeChild === prev.installed.removeChild ? prev.original.removeChild : prototype.removeChild,
			clear: prev && prototype.clear === prev.installed.clear ? prev.original.clear : prototype.clear,
		};
		const state: PatchState = {
			active: true,
			prototype,
			original,
			installed: undefined as any,
		};
		state.installed = {
			addChild: function (this: any, component: any) {
				const cacheMissText = extractCacheMissNotice(component);
				if (cacheMissText) {
					const children = this.children;
					if (Array.isArray(children) && children.length > 0) {
						const lastChild = children[children.length - 1];
						if (isSpacer(lastChild)) {
							state.original.removeChild.call(this, lastChild);
						}
					}
					if (absorbCacheMissNotice(this, cacheMissText)) {
						return component;
					}
				}
				const result = state.original.addChild.call(this, component);
				if (component && typeof component === "object") {
					// Remember where the current assistant message component lives so a
					// thinking-only group can be inserted right after it later.
					if (isAssistantMessage(component)) {
						const assistant = component as any;
						ensureAssistantThinkingPatched(assistant);
						const streaming = assistant.isStreaming === true;
						if (streaming) {
							assistant[LIVE_ASSISTANT_KEY] = true;
						}
						runtime.lastChatContainer = this;
						runtime.lastStreamingComp = assistant;
						assistant[IS_STREAMING_COMP] = streaming;
						// Keep one open block across assistant messages until visible text.
						// A rebuilt message that already has text is that boundary.
						if (assistantHasVisibleText(assistant)) {
							sealOpenGroupAtAssistantText(assistant);
						} else {
							const open = findOpenGroup();
							if (open) placeGroupAfter(this, assistant, open);
						}
						// A run that started before its message component existed can now
						// be placed in the transcript, in front of this message's text.
						if (runtime.unattachedThinking.length > 0) ensureThinkingGroup();
						flushPendingTextSeal();
					}
					maybeGroup(this, component);
					stripAssistantPhantomPadding(this, component);
					restoreAssistantAnchor(this, component);
				}
				return result;
			},
			removeChild: function (this: any, component: any) {
				const group = component?.[PARENT_KEY];
				if (isToolGroup(group) && (group as any)[PARENT_KEY] === this) {
					group.removeTool(component);
					if (group.children.length === 0 && group.entries.length === 0) runtime.groups.delete(group);
					return;
				}
				releaseAssistantAnchors(component);
				return state.original.removeChild.call(this, component);
			},
			clear: function (this: any) {
				if (runtime.assistantContentContainers.has(this)) {
					// AssistantMessageComponent rebuilds this container for every
					// cumulative stream update. Keep sealed compact groups in the
					// anchor map; restoreAssistantAnchor() reinserts each one before
					// its matching Markdown child as the rebuild proceeds.
					getAssistantContentState(this).nextTextOrdinal = 0;
					return state.original.clear.call(this);
				}
				for (const child of [...(this.children ?? [])]) {
					if (isToolGroup(child)) {
						for (const tool of [...child.children] as any[]) delete tool[PARENT_KEY];
						runtime.groups.delete(child);
					}
					releaseAssistantAnchors(child);
				}
				return state.original.clear.call(this);
			},
		};
		prototype.addChild = state.installed.addChild;
		prototype.removeChild = state.installed.removeChild;
		prototype.clear = state.installed.clear;
		stateMap.set(prototype, state);
	}
	host[patchKey] = stateMap;
}
