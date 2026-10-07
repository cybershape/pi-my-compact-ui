/** 集中管理会话状态；集合与锚点通过工厂创建，便于测试隔离。 */
import type { ThinkingEntry, PreparingTool, AssistantContentState } from "./types.js";
import type { ToolGroupComponent } from "./tool-group.js";
import type { OverlayHandle, Container } from "@earendil-works/pi-tui";
import type { DetailModalComponent, InspectSelectorModal } from "./modals.js";

/** Mutable session/UI state. A fresh snapshot also makes isolated tests possible. */
export interface RuntimeState {
	currentTheme: any;
	activeThinking: ThinkingEntry | null;
	activeThinkingIndex: number | null;
	activeThinkingBlocks: Map<number, string>;
	unattachedThinking: ThinkingEntry[];
	thinkingEntrySeq: number;
	noticeEntrySeq: number;
	handledTextIndexes: Set<number>;
	sealedThinkingIndexes: Set<number>;
	pendingTextSeal: boolean;
	pendingTextOrdinal: number | null;
	lastActiveGroup: ToolGroupComponent | null;
	lastSealedThinkingEntry: ThinkingEntry | null;
	lastReportedReasoningTokens: number;
	lastStreamingComp: any;
	lastChatContainer: any;
	toolStarts: Map<string, number>;
	toolDurations: Map<string, number>;
	turnStartMs: number;
	/** Observable work between streamed thinking and tool execution. Null when inactive. */
	agentWorkPhase: "working" | "waiting-response" | "waiting-output" | null;
	preparingByIndex: Map<number, PreparingTool>;
	activeModalHandle: OverlayHandle | null;
	activeModalComponent: DetailModalComponent | null;
	activeModalCloseFn: (() => void) | null;
	activeUIContext: any;
	activeSelectorHandle: OverlayHandle | null;
	activeSelectorComponent: InspectSelectorModal | null;
	activeSelectorCloseFn: (() => void) | null;
	animTimer: ReturnType<typeof setTimeout> | null;
	capturedTui: any;
	groups: Set<ToolGroupComponent>;
	assistantContentContainers: WeakSet<Container>;
	assistantContentStates: WeakMap<Container, AssistantContentState>;
	groupAnchors: WeakMap<ToolGroupComponent, { container: Container; ordinal: number; }>;
}

export function createRuntimeState(): RuntimeState {
	return {
		currentTheme: null,
		activeThinking: null,
		activeThinkingIndex: null,
		activeThinkingBlocks: new Map<number, string>(),
		unattachedThinking: [],
		thinkingEntrySeq: 0,
		noticeEntrySeq: 0,
		handledTextIndexes: new Set<number>(),
		sealedThinkingIndexes: new Set<number>(),
		pendingTextSeal: false,
		pendingTextOrdinal: null,
		lastActiveGroup: null,
		lastSealedThinkingEntry: null,
		lastReportedReasoningTokens: 0,
		lastStreamingComp: null,
		lastChatContainer: null,
		toolStarts: new Map<string, number>(),
		toolDurations: new Map<string, number>(),
		turnStartMs: 0,
		agentWorkPhase: null,
		preparingByIndex: new Map<number, PreparingTool>(),
		activeModalHandle: null,
		activeModalComponent: null,
		activeModalCloseFn: null,
		activeUIContext: null,
		activeSelectorHandle: null,
		activeSelectorComponent: null,
		activeSelectorCloseFn: null,
		animTimer: null,
		capturedTui: null,
		groups: new Set<ToolGroupComponent>(),
		assistantContentContainers: new WeakSet<Container>(),
		assistantContentStates: new WeakMap<Container, AssistantContentState>(),
		groupAnchors: new WeakMap<ToolGroupComponent, { container: Container; ordinal: number }>(),
	};
}

export const runtime = createRuntimeState();
