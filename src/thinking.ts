/** 思考段生命周期与估算/精确 token 用量更新。 */
import { runtime } from "./state.js";
import { estimateTextTokens } from "./helpers.js";
import type { ThinkingEntry } from "./types.js";

export function updateActiveThinkingTokens(message: any): void {
	const entry = runtime.activeThinking;
	if (!entry) return;
	entry.text = [...runtime.activeThinkingBlocks.values()].filter((text) => text.trim()).join("\n\n");
	// Most providers report reasoning usage only when the response finishes. While
	// streaming, fall back to pi's own chars/4 token heuristic and mark it with ≈.
	const reported = Number(message?.usage?.reasoning);
	if (Number.isFinite(reported) && reported > 0) {
		entry.tokens = reported;
		entry.tokensExact = true;
		runtime.lastReportedReasoningTokens = reported;
		return;
	}
	entry.tokens = estimateTextTokens(entry.text);
	entry.tokensExact = false;
}

export function createThinkingEntry(): ThinkingEntry {
	const entry: ThinkingEntry = {
		kind: "thinking",
		id: runtime.thinkingEntrySeq++,
		text: "",
		tokens: 0,
		tokensExact: false,
		active: true,
		owner: null,
	};
	runtime.activeThinking = entry;
	runtime.activeThinkingBlocks.clear();
	runtime.unattachedThinking.push(entry);
	return entry;
}

export function finalizeActiveThinking(): void {
	const entry = runtime.activeThinking;
	if (!entry) return;
	entry.active = false;
	entry.owner?.invalidate();
	if (runtime.activeThinkingIndex !== null) runtime.sealedThinkingIndexes.add(runtime.activeThinkingIndex);
	runtime.lastSealedThinkingEntry = entry;
	runtime.activeThinking = null;
	runtime.activeThinkingIndex = null;
	runtime.activeThinkingBlocks.clear();
}

export function refreshSealedThinkingTokens(reportedReasoning?: unknown): void {
	const reported = Number(reportedReasoning);
	if (Number.isFinite(reported) && reported > 0) runtime.lastReportedReasoningTokens = reported;
	const entry = runtime.lastSealedThinkingEntry;
	if (!entry || entry.tokensExact) return;
	if (!entry.text.trim()) return; // no thinking row to correct
	if (!(runtime.lastReportedReasoningTokens > 0)) return;
	entry.tokens = runtime.lastReportedReasoningTokens;
	entry.tokensExact = true;
	entry.owner?.invalidate();
	runtime.capturedTui?.requestRender?.();
}
