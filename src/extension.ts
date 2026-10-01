/** Pi 命令与事件接入；呈现逻辑委托给各职责模块。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installGrouping, ensureThinkingGroup, flushPendingTextSeal } from "./grouping.js";
import { installNativeThinkingSuppression, removeGroupFromContainer, insertTurnDivider } from "./assistant-patches.js";
import { installCompactionSummaryRendering } from "./compaction.js";
import { openInspectSelectorModal, closeDetailModal, closeInspectSelectorModal } from "./modals.js";
import { runtime } from "./state.js";
import { isKeyRelease, matchesKey, Key } from "@earendil-works/pi-tui";
import { isCtrlI } from "./helpers.js";
import { rememberToolStart, clearPreparingTools, noteStreamingToolCall } from "./streaming-tools.js";
import { finalizeActiveThinking, createThinkingEntry, updateActiveThinkingTokens, refreshSealedThinkingTokens } from "./thinking.js";
import { registerConfigCommand } from "./settings.js";

export default function (pi: ExtensionAPI) {
	installGrouping();
	installNativeThinkingSuppression();
	installCompactionSummaryRendering();

	// Do not use pi.registerShortcut("ctrl+i") directly because pi's internal
	// matchesKey treats "\t" as "ctrl+i", which breaks regular Tab completion.
	// Instead, recognize Ctrl+I under extended protocols via onTerminalInput + isCtrlI.

	pi.registerCommand("compact-inspect", {
		description: "Select a tool call or thinking entry to inspect details (Shortcut: Ctrl+I)",
		handler: async () => {
			openInspectSelectorModal();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		runtime.currentTheme = ctx.ui.theme;
		runtime.activeUIContext = ctx.ui;
		ctx.ui.setHiddenThinkingLabel("");

		ctx.ui.onTerminalInput((data: string) => {
			if (isKeyRelease(data)) {
				return runtime.activeModalHandle || runtime.activeSelectorHandle ? { consume: true } : undefined;
			}

			if (runtime.activeModalHandle) {
				if (matchesKey(data, Key.escape) || data === "q" || data === "Q" || isCtrlI(data)) {
					closeDetailModal();
					return { consume: true };
				}
				return undefined;
			}

			if (runtime.activeSelectorHandle) {
				if (matchesKey(data, Key.escape) || data === "q" || data === "Q" || isCtrlI(data)) {
					closeInspectSelectorModal();
					return { consume: true };
				}
				return undefined;
			}

			if (isCtrlI(data)) {
				openInspectSelectorModal();
				return { consume: true };
			}

			return undefined;
		});

		// Capture the TUI instance via setWidget's factory so the animation can
		// call its throttled requestRender() to repaint just the changed cells.
		ctx.ui.setWidget("compact-anim", (tui: any) => {
			runtime.capturedTui = tui;
			return { render: () => [] as string[], invalidate() {} };
		});
		installGrouping();
		installNativeThinkingSuppression();
		installCompactionSummaryRendering();
	});

	pi.on("session_shutdown", async () => {
		closeDetailModal();
		closeInspectSelectorModal();
	});

	pi.on("tool_execution_start", async (event) => {
		// Keep the timestamp captured when arguments started streaming.
		rememberToolStart(event.toolCallId);
		runtime.lastActiveGroup?.invalidate();
		runtime.activeSelectorComponent?.refreshEntries();
		runtime.capturedTui?.requestRender?.();
	});

	pi.on("tool_execution_end", async (event) => {
		for (const g of runtime.groups) {
			for (const t of g.children as any[]) {
				if (t.toolCallId === event.toolCallId) t._groupEndAt = Date.now();
			}
		}
		runtime.lastActiveGroup?.invalidate();
		runtime.activeSelectorComponent?.refreshEntries();
		runtime.capturedTui?.requestRender?.();
	});

	pi.on("message_start", async (event) => {
		const role = (event.message as any)?.role;
		// A new user message is a hard turn boundary: seal whatever block is still
		// open. Assistant/toolResult message boundaries do NOT seal — thinking and
		// tool calls stay in one block until real (non-thinking) text appears.
		if (role === "user" && runtime.lastActiveGroup && !runtime.lastActiveGroup.sealed) {
			runtime.lastActiveGroup.sealed = true;
			finalizeActiveThinking();
			runtime.lastActiveGroup.invalidate();
		}
		if (role === "user") {
			for (const g of [...runtime.groups]) {
				if (!g.hasVisibleEntries()) {
					if (runtime.lastChatContainer) removeGroupFromContainer(runtime.lastChatContainer, g);
					runtime.groups.delete(g);
				}
			}
			runtime.turnStartMs = Date.now();
			runtime.activeThinking = null;
			runtime.activeThinkingIndex = null;
			runtime.activeThinkingBlocks.clear();
			runtime.unattachedThinking.length = 0;
			clearPreparingTools();
			runtime.lastSealedThinkingEntry = null;
			runtime.lastReportedReasoningTokens = 0;
			runtime.handledTextIndexes.clear();
			runtime.sealedThinkingIndexes.clear();
			runtime.pendingTextSeal = false;
			runtime.pendingTextOrdinal = null;
			runtime.lastStreamingComp = null;
		} else if (role === "assistant") {
			// contentIndex values are local to one streamed assistant message. Close
			// any run left open by the previous message; a late thinking_end for it is
			// then rejected through sealedThinkingIndexes.
			finalizeActiveThinking();
			runtime.handledTextIndexes.clear();
			runtime.sealedThinkingIndexes.clear();
			// Reported reasoning usage belongs to one assistant message; a run sealed
			// later must not inherit the previous message's value.
			runtime.lastSealedThinkingEntry = null;
			runtime.lastReportedReasoningTokens = 0;
			runtime.pendingTextSeal = false;
			runtime.pendingTextOrdinal = null;
			// Do not insert early thinking beside the previous assistant message.
			// The addChild patch fills this with the current streaming component.
			runtime.lastStreamingComp = null;
		}
	});

	pi.on("message_update", async (event) => {
		const msg = event.message as any;
		if (!msg || msg.role !== "assistant") return;
		const content = Array.isArray(msg.content) ? msg.content : [];
		const streamEvent = event.assistantMessageEvent as any;
		const streamType = String(streamEvent?.type ?? "");

		if (streamType.startsWith("thinking_")) {
			// Only read the block targeted by this stream event. The surrounding
			// message is cumulative and may still contain thinking from before a
			// text boundary; scanning all content would resurrect that old block.
			const contentIndex = Number(streamEvent.contentIndex);
			const hasIndex = Number.isInteger(contentIndex);
			// A thinking_end re-emitted after a visible text boundary already sealed
			// this run must not create a second row for the same reasoning.
			if (hasIndex && runtime.sealedThinkingIndexes.has(contentIndex)) return;
			const startsRun =
				streamType === "thinking_start" || !runtime.activeThinking || (hasIndex && runtime.activeThinkingIndex !== contentIndex);
			if (startsRun) {
				// Each run is its own entry: close the previous one instead of merging.
				finalizeActiveThinking();
				runtime.activeThinkingIndex = hasIndex ? contentIndex : null;
				createThinkingEntry();
			}
			const block = hasIndex ? content[contentIndex] : undefined;
			const blockText =
				block?.type === "thinking"
					? String(block.thinking ?? "")
					: streamType === "thinking_end"
						? String(streamEvent.content ?? "")
						: "";
			if (hasIndex) runtime.activeThinkingBlocks.set(contentIndex, blockText);
			updateActiveThinkingTokens(msg);
			// Drop the row in as soon as the run starts — even before its first delta —
			// so the spinner reports the in-progress state.
			ensureThinkingGroup();
			if (streamType === "thinking_end") finalizeActiveThinking();
		} else if (streamType.startsWith("text_")) {
			const contentIndex = Number(streamEvent.contentIndex);
			const block = Number.isInteger(contentIndex) ? content[contentIndex] : undefined;
			const text = block?.type === "text" ? String(block.text ?? "").trim() : "";
			// The first non-whitespace text is a boundary. Deduplicate by content
			// index so every later cumulative delta extends the same text block.
			if (text.length > 0 && !runtime.handledTextIndexes.has(contentIndex)) {
				if (runtime.activeThinking) updateActiveThinkingTokens(msg);
				runtime.handledTextIndexes.add(contentIndex);
				runtime.pendingTextSeal = true;
				runtime.pendingTextOrdinal =
					content
						.slice(0, Number.isInteger(contentIndex) ? contentIndex + 1 : content.length)
						.filter((item: any) => item?.type === "text" && String(item.text ?? "").trim()).length - 1;
				flushPendingTextSeal();
			}
		} else if (streamType.startsWith("toolcall_")) {
			// Arguments are still streaming. Show the busy row before execution starts.
			if (runtime.activeThinking) updateActiveThinkingTokens(msg);
			noteStreamingToolCall(content, streamEvent);
		} else if (streamType === "done" || streamType === "error") {
			if (runtime.activeThinking) updateActiveThinkingTokens(msg);
			finalizeActiveThinking();
			refreshSealedThinkingTokens(msg?.usage?.reasoning);
		}

		// Refresh the active block when thinking starts/stops (event-driven only;
		// no timer, so the transcript scroll position is never yanked around).
		runtime.lastActiveGroup?.invalidate();
		runtime.activeSelectorComponent?.refreshEntries();
		runtime.capturedTui?.requestRender?.();
	});

	pi.on("agent_end", async () => {
		// Turn finished: seal the final block so it stops spinning and shows a
		// stable summary until the user starts the next turn.
		clearPreparingTools();
		if (runtime.lastActiveGroup && !runtime.lastActiveGroup.sealed) {
			runtime.lastActiveGroup.sealed = true;
			finalizeActiveThinking();
			runtime.lastActiveGroup.invalidate();
		}
		for (const g of [...runtime.groups]) {
			if (!g.hasVisibleEntries()) {
				if (runtime.lastChatContainer) removeGroupFromContainer(runtime.lastChatContainer, g);
				runtime.groups.delete(g);
			}
		}
		refreshSealedThinkingTokens();
		runtime.activeSelectorComponent?.refreshEntries();
		runtime.capturedTui?.requestRender?.();
		// Separate the final visible text from the preceding work with a divider
		// that reports how long this turn ran.
		const elapsedMs = Date.now() - runtime.turnStartMs;
		insertTurnDivider(elapsedMs);
		runtime.activeThinking = null;
		runtime.activeThinkingIndex = null;
		runtime.activeThinkingBlocks.clear();
		runtime.unattachedThinking.length = 0;
		runtime.lastSealedThinkingEntry = null;
		runtime.lastReportedReasoningTokens = 0;
		runtime.handledTextIndexes.clear();
		runtime.sealedThinkingIndexes.clear();
		runtime.pendingTextSeal = false;
		runtime.pendingTextOrdinal = null;
	});

	registerConfigCommand(pi);
}
