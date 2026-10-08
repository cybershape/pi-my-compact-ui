/** 适配 Pi 原生 assistant 组件：历史思考、正文锚点与回合耗时分隔线。 */
import { runtime } from "./state.js";
import type { AssistantContentState, ThinkingEntry } from "./types.js";
import { ToolGroupComponent } from "./tool-group.js";
import { estimateTextTokens, formatWorkedTime } from "./helpers.js";
import { Spacer, truncateToWidth } from "@earendil-works/pi-tui";
import type { Container, Markdown } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { ASSISTANT_THINKING_PATCH_KEY, LIVE_ASSISTANT_KEY, IS_STREAMING_COMP, GROUP_MOUNT, PARENT_KEY } from "./constants.js";
import { isAssistantMessage, isContainer, isToolGroup, isMarkdown, isSpacer, isText } from "./guards.js";

export function thinkingAlreadyShown(text: string): boolean {
	const norm = text.trim();
	if (!norm) return true;
	if (runtime.activeThinking && runtime.activeThinking.text.trim() === norm) return true;
	for (const entry of runtime.unattachedThinking) {
		if (entry.text.trim() === norm) return true;
	}
	for (const group of runtime.groups) {
		for (const entry of group.entries) {
			if (entry.kind === "thinking" && entry.text.trim() === norm) return true;
		}
	}
	return false;
}

export function stageHistoricalThinking(
	state: AssistantContentState,
	ordinal: number,
	texts: string[],
	message: any,
): void {
	if (state.anchors.has(ordinal)) return;
	const fresh = texts.filter((text, index) => text.trim() && texts.indexOf(text) === index && !thinkingAlreadyShown(text));
	if (fresh.length === 0) return;
	const group = new ToolGroupComponent();
	group.anchored = true;
	group.sealed = true;
	const reasoningTokens = Number(message?.usage?.reasoning);
	const tokensExact = Number.isFinite(reasoningTokens) && reasoningTokens > 0;
	for (const text of fresh) {
		const entry: ThinkingEntry = {
			kind: "thinking",
			id: runtime.thinkingEntrySeq++,
			text,
			tokens: tokensExact ? reasoningTokens : estimateTextTokens(text),
			tokensExact,
			active: false,
			owner: group,
		};
		group.entries.push(entry);
	}
	if (!group.hasVisibleEntries()) return;
	state.anchors.set(ordinal, group);
	runtime.groups.add(group);
}

export function ensureHistoricalThinkingAnchors(
	contentContainer: Container,
	message: any,
): void {
	const content = Array.isArray(message?.content) ? message.content : undefined;
	if (!content || content.length === 0) return;

	const state = getAssistantContentState(contentContainer);
	let currentThinkingBlocks: string[] = [];
	let textOrdinal = 0;

	for (const item of content) {
		if (item?.type === "thinking") {
			const text = String(item.thinking ?? "").trim();
			if (text) currentThinkingBlocks.push(text);
		} else if (item?.type === "text" && String(item.text ?? "").trim()) {
			stageHistoricalThinking(state, textOrdinal, currentThinkingBlocks, message);
			currentThinkingBlocks = [];
			textOrdinal++;
		}
	}

	const hasToolCalls = content.some((item: any) => item?.type === "toolCall");
	if (!hasToolCalls && textOrdinal === 0 && currentThinkingBlocks.length > 0) {
		stageHistoricalThinking(state, 0, currentThinkingBlocks, message);
	}
}

export function installNativeThinkingSuppression(prototype: any = AssistantMessageComponent.prototype): void {
	if (!prototype || typeof prototype.updateContent !== "function") return;
	const previous = prototype[ASSISTANT_THINKING_PATCH_KEY] as
		| {
				originalUpdateContent: (this: any, message: any, isStreaming?: boolean) => void;
				installedUpdateContent: (this: any, message: any, isStreaming?: boolean) => void;
		  }
		| undefined;
	const originalUpdateContent =
		previous && prototype.updateContent === previous.installedUpdateContent
			? previous.originalUpdateContent
			: (prototype.updateContent as (this: any, message: any, isStreaming?: boolean) => void);
	const installedUpdateContent = function (this: any, message: any, isStreaming?: boolean): void {
		const contentContainer = this.contentContainer;
		if (contentContainer) {
			runtime.assistantContentContainers.add(contentContainer);
		}
		if (isStreaming === true) {
			this[LIVE_ASSISTANT_KEY] = true;
		}
		const isLive = Boolean(this[LIVE_ASSISTANT_KEY]) || isStreaming === true || (this as any)[IS_STREAMING_COMP] === true || this === runtime.lastStreamingComp;

		const content = Array.isArray(message?.content) ? message.content : undefined;
		const hasToolCalls = Boolean(content?.some((item: any) => item?.type === "toolCall"));
		const hasText = Boolean(content?.some((item: any) => item?.type === "text" && String(item?.text ?? "").trim()));

		// Historical anchor reconstruction is ONLY for non-live messages loaded from history.
		// If the message is currently live or was streamed live in this session, its thinking is ALREADY in the compact tree.
		if (!isLive && contentContainer && message?.content) {
			ensureHistoricalThinkingAnchors(contentContainer, message);
		}

		if (!content?.some((item: any) => item?.type === "thinking")) {
			originalUpdateContent.call(this, message, isStreaming);
			return;
		}
		originalUpdateContent.call(
			this,
			{
				...message,
				content: content.filter((item: any) => item?.type !== "thinking"),
			},
			isStreaming,
		);

		// If this was a true historical thinking-only message (NO text AND NO tool calls), attach the group.
		// If it has tool calls, its thinking belongs to the tool group — NEVER attach it here.
		if (!isLive && !hasToolCalls && !hasText && contentContainer) {
			const state = getAssistantContentState(contentContainer);
			const group = state.anchors.get(0);
			if (group && group.hasVisibleEntries() && !contentContainer.children.includes(group)) {
				detachGroup(group, contentContainer);
				contentContainer.addChild(new Spacer(1));
				contentContainer.addChild(group);
				contentContainer.addChild(new Spacer(1));
				noteGroupMount(contentContainer, group);
			}
		}
	};
	prototype.updateContent = installedUpdateContent;
	if (typeof prototype.setHideThinkingBlock === "function") {
		const originalSetHideThinkingBlock = prototype.setHideThinkingBlock as (this: any, hide: boolean) => void;
		prototype.setHideThinkingBlock = function (this: any, _hide: boolean): void {
			// Thinking stays in the compact tree. Letting Pi show it again paints a second copy.
			this.hiddenThinkingLabel = "";
			originalSetHideThinkingBlock.call(this, true);
		};
	}
	if (typeof prototype.setHiddenThinkingLabel === "function") {
		const originalSetHiddenThinkingLabel = prototype.setHiddenThinkingLabel as (this: any, label: string) => void;
		prototype.setHiddenThinkingLabel = function (this: any, _label: string): void {
			this.hiddenThinkingLabel = "";
			originalSetHiddenThinkingLabel.call(this, "");
		};
	}
	prototype[ASSISTANT_THINKING_PATCH_KEY] = {
		originalUpdateContent,
		installedUpdateContent,
	};
}

export function ensureAssistantThinkingPatched(component: any): boolean {
	const prototype = Object.getPrototypeOf(component);
	const already = Boolean(prototype?.[ASSISTANT_THINKING_PATCH_KEY]);
	installNativeThinkingSuppression(prototype);
	component.hideThinkingBlock = true;
	component.hiddenThinkingLabel = "";
	return already;
}

export function getAssistantContentState(container: Container): AssistantContentState {
	let state = runtime.assistantContentStates.get(container);
	if (!state) {
		state = { anchors: new Map(), nextTextOrdinal: 0 };
		runtime.assistantContentStates.set(container, state);
	}
	return state;
}

export function removeGroupFromContainer(container: any, group: ToolGroupComponent): void {
	const children = container?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(group);
	if (index >= 0) children.splice(index, 1);
	if ((group as any)[GROUP_MOUNT] === container) delete (group as any)[GROUP_MOUNT];
}

export function noteGroupMount(container: any, group: ToolGroupComponent): void {
	(group as any)[GROUP_MOUNT] = container;
}

export function detachGroup(group: ToolGroupComponent, keep?: any): void {
	const mounted = (group as any)[GROUP_MOUNT];
	if (mounted && mounted !== keep) removeGroupFromContainer(mounted, group);
	if (runtime.lastChatContainer && runtime.lastChatContainer !== keep) removeGroupFromContainer(runtime.lastChatContainer, group);
	const anchor = runtime.groupAnchors.get(group);
	if (anchor?.container && anchor.container !== keep) removeGroupFromContainer(anchor.container, group);
}

export function removeComponentFromContainer(container: any, component: any): void {
	const children = container?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index >= 0) children.splice(index, 1);
}

export class TurnDividerComponent {
	private readonly timeLabel: string;

	constructor(timeLabel: string) {
		this.timeLabel = timeLabel;
	}

	render(width: number): string[] {
		const theme = runtime.currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const middle = `worked for ${this.timeLabel}`;
		const avail = Math.max(6, width - middle.length - 2);
		const left = Math.floor(avail / 2);
		const right = avail - left;
		const dash = (n: number) => "─".repeat(Math.max(0, n));
		const line = `${fg("dim", dash(left))} ${fg("muted", middle)} ${fg("dim", dash(right))}`;
		return [truncateToWidth(line, Math.max(1, width)), ""];
	}

	invalidate(): void {}
}

export function placeTurnDividerBeforeText(container: Container, target: Markdown, divider: any): void {
	const targetIndex = container.children.indexOf(target);
	if (targetIndex < 0) return;
	removeComponentFromContainer(container, divider);
	container.children.splice(targetIndex, 0, divider);
}

export function insertTurnDivider(elapsedMs: number): void {
	if (elapsedMs < 1000) return;
	let comp: any = runtime.lastStreamingComp;
	if (!comp || !isAssistantMessage(comp)) {
		if (!runtime.lastChatContainer) return;
		const children = (runtime.lastChatContainer as any)?.children;
		if (!Array.isArray(children)) return;
		for (let i = children.length - 1; i >= 0; i--) {
			if (isAssistantMessage(children[i])) {
				comp = children[i];
				break;
			}
		}
	}
	if (!comp) return;
	const contentContainer = (comp as any).contentContainer;
	if (!isContainer(contentContainer)) return;

	const markdowns = contentContainer.children.filter(isVisibleTextMarkdown);
	if (markdowns.length === 0) return;
	const final = markdowns[markdowns.length - 1];
	const finalIndex = contentContainer.children.indexOf(final);
	// Only separate the final text from preceding work (an anchored tool/thinking
	// group). A plain text-only answer gets no divider.
	const hasPriorContent = contentContainer.children
		.slice(0, finalIndex)
		.some((child) => isToolGroup(child) && child.hasVisibleEntries());
	if (!hasPriorContent) return;

	const state = getAssistantContentState(contentContainer);
	if (state.finalDivider && contentContainer.children.includes(state.finalDivider.component)) return;
	const ordinal = markdowns.length - 1;
	const divider = new TurnDividerComponent(formatWorkedTime(elapsedMs));
	state.finalDivider = { ordinal, component: divider };
	placeTurnDividerBeforeText(contentContainer, final, divider);
	contentContainer.invalidate?.();
	runtime.capturedTui?.requestRender?.();
}

export function isVisibleTextMarkdown(component: any): component is Markdown {
	// Thinking Markdown receives a defaultTextStyle ({ color, italic }) from
	// AssistantMessageComponent; normal assistant text does not. Count only
	// normal text blocks so anchors remain correct if thinking visibility is
	// toggled on.
	return isMarkdown(component) && !(component as any).defaultTextStyle;
}

export function placeAnchoredGroupBeforeText(container: Container, target: Markdown, group: ToolGroupComponent): void {
	detachGroup(group, container);
	const targetIndex = container.children.indexOf(target);
	if (targetIndex < 0) return;

	// Pi may accumulate one Spacer for the message itself plus one Spacer for
	// every hidden thinking run before this text. Tool loops can therefore leave
	// an arbitrarily large run here. Replace the entire run with a deterministic
	// boundary:
	//
	//   previous text/content -> one blank -> compact group -> one blank -> text
	//
	// This also makes repeated cumulative AssistantMessageComponent rebuilds
	// idempotent instead of accumulating more spacing around restored anchors.
	let spacerStart = targetIndex;
	while (spacerStart > 0 && isSpacer(container.children[spacerStart - 1])) spacerStart--;
	if (targetIndex > spacerStart) {
		container.children.splice(spacerStart, targetIndex - spacerStart);
	}
	group.anchored = true;
	container.children.splice(spacerStart, 0, new Spacer(1), group, new Spacer(1));
	noteGroupMount(container, group);
}

export function insertAnchoredGroup(container: Container, ordinal: number, group: ToolGroupComponent): void {
	if (!group.hasVisibleEntries()) return;
	const markdowns = container.children.filter(isVisibleTextMarkdown);
	const target = markdowns[ordinal];
	if (!target) return;
	removeGroupFromContainer(container, group);
	placeAnchoredGroupBeforeText(container, target, group);
}

export function anchorGroupBeforeCurrentText(group: ToolGroupComponent, ordinal: number): void {
	if (!runtime.lastStreamingComp || !runtime.lastChatContainer) return;
	const contentContainer = (runtime.lastStreamingComp as any).contentContainer;
	if (!isContainer(contentContainer)) return;

	// An open group normally lives directly in the chat container. Remove it
	// there before nesting it at the exact text boundary.
	removeGroupFromContainer(runtime.lastChatContainer, group);

	const previousAnchor = runtime.groupAnchors.get(group);
	if (previousAnchor) {
		const previousState = runtime.assistantContentStates.get(previousAnchor.container);
		if (previousState?.anchors.get(previousAnchor.ordinal) === group) {
			previousState.anchors.delete(previousAnchor.ordinal);
		}
		removeGroupFromContainer(previousAnchor.container, group);
	}

	if (!group.hasVisibleEntries()) {
		runtime.groups.delete(group);
		return;
	}

	const state = getAssistantContentState(contentContainer);
	const replaced = state.anchors.get(ordinal);
	if (replaced && replaced !== group) {
		removeGroupFromContainer(contentContainer, replaced);
		replaced.anchored = false;
		runtime.groupAnchors.delete(replaced);
		runtime.groups.delete(replaced);
	}
	state.anchors.set(ordinal, group);
	runtime.groupAnchors.set(group, { container: contentContainer, ordinal });
	insertAnchoredGroup(contentContainer, ordinal, group);
	runtime.lastChatContainer.invalidate?.();
	runtime.capturedTui?.requestRender?.();
}

export function restoreAssistantAnchor(parent: any, component: any): void {
	if (!runtime.assistantContentContainers.has(parent) || !isVisibleTextMarkdown(component)) return;
	const state = getAssistantContentState(parent);
	const ordinal = state.nextTextOrdinal++;
	const group = state.anchors.get(ordinal);
	if (group && group.hasVisibleEntries()) {
		removeGroupFromContainer(parent, group);
		placeAnchoredGroupBeforeText(parent, component, group);
	}
	const divider = state.finalDivider;
	if (divider && divider.ordinal === ordinal) {
		placeTurnDividerBeforeText(parent, component, divider.component);
	}
}

export function releaseAssistantAnchors(component: any): void {
	if (!isAssistantMessage(component)) return;
	const contentContainer = (component as any).contentContainer;
	if (!isContainer(contentContainer)) return;
	const state = runtime.assistantContentStates.get(contentContainer);
	if (!state) return;
	for (const group of state.anchors.values()) {
		for (const tool of [...group.children]) delete (tool as any)[PARENT_KEY];
		runtime.groupAnchors.delete(group);
		runtime.groups.delete(group);
	}
	state.anchors.clear();
	state.finalDivider = undefined;
}

export function stripAssistantPhantomPadding(parent: any, component: any): void {
	// Mark the plain Container that an AssistantMessageComponent owns as its
	// content container so we can trim its children later.
	if (isAssistantMessage(parent) && isContainer(component) && !isAssistantMessage(component)) {
		runtime.assistantContentContainers.add(component);
		getAssistantContentState(component);
		return;
	}
	if (!runtime.assistantContentContainers.has(parent)) return;
	// Pi still builds a native thinking widget (full Markdown, or the hidden
	// "Thinking..." label) beside the compact tree. Drop that widget so the run
	// is visible only inside the tree.
	if (!isNativeThinkingWidget(component)) return;
	const index = parent.children.indexOf(component);
	if (index >= 0) parent.children.splice(index, 1);
	if (isSpacer(parent.children[index])) parent.children.splice(index, 1);
	while (parent.children.length > 0 && parent.children.every((child: any) => isSpacer(child))) parent.children.pop();
}

export function isNativeThinkingWidget(component: any): boolean {
	if (!component || isToolGroup(component)) return false;
	if (component.constructor?.name === "MouseRegion" && component.child) {
		return isNativeThinkingWidget(component.child);
	}
	if (isMarkdown(component) && (component as any).defaultTextStyle) return true;
	if (!isText(component)) return false;
	const visible = String((component as any).text ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();
	return visible === "" || visible === "Thinking..." || visible === "thinking" || visible === "thinking...";
}
