/** 无运行状态依赖的格式化与流式工具参数解析。 */
import { homedir } from "os";
import type { ThinkingEntry, ToolStatus } from "./types.js";
import { isKeyRelease, parseKey, matchesKey } from "@earendil-works/pi-tui";

export function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function oneLine(value: unknown, max?: number): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (typeof max === "number" && text.length > max) {
		return max <= 3 ? "...".slice(0, max) : `${text.slice(0, max - 3)}...`;
	}
	return text;
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function formatTokenK(tokens: number): string {
	if (tokens <= 0) return "0.0K";
	if (tokens < 100) return "<0.1K";
	const value = tokens / 1000;
	return value < 100 ? `${value.toFixed(1)}K` : `${Math.round(value)}K`;
}

export function thinkingTokenLabel(entry: ThinkingEntry): string {
	const tokens = Math.max(0, Math.round(Number(entry?.tokens) || 0));
	if (tokens < 1000) {
		return `(${tokens}t)`;
	}
	const k = tokens / 1000;
	const formatted = k < 100 ? k.toFixed(1) : Math.round(k).toString();
	return `(${formatted}k)`;
}

export function toolSummary(name: string, args: any): { name: string; content: string } {
	switch (name) {
		case "bash":
		case "powershell":
			return { name, content: oneLine(args?.command || "...") };
		case "read":
			return { name: "read", content: shortenPath(args?.path || "...") };
		case "write":
		case "edit":
			return { name, content: shortenPath(args?.path || "...") };
		case "find":
			return { name: "find", content: `${oneLine(args?.pattern || "")} in ${shortenPath(args?.path || ".")}` };
		case "grep":
			return { name: "grep", content: `${oneLine(args?.pattern || "")} in ${shortenPath(args?.path || ".")}` };
		case "ls":
			return { name: "ls", content: shortenPath(args?.path || ".") };
		case "web_search":
			return { name: "web_search", content: oneLine(args?.query || "...") };
		case "subagent":
			return { name: "subagent", content: oneLine(args?.agent || args?.task || "...") };
		default: {
			const preferred = args?.path ?? args?.query ?? args?.name ?? args?.description ?? args?.url;
			return { name, content: oneLine(preferred ?? "...") };
		}
	}
}

export function toolStatus(tool: any): ToolStatus {
	if (tool?.result?.isError) return "error";
	if (tool?.isPartial === true || (tool?.executionStarted && !tool?.result)) return "pending";
	return tool?.result ? "success" : "pending";
}

export function streamingToolArgs(block: any): any {
	const args = block?.arguments && typeof block.arguments === "object" ? block.arguments : {};
	if (Object.keys(args).length > 0) return args;
	const partial = String(block?.partialJson || block?.partialArgs || "").trim();
	if (!partial) return args;
	const name = String(block?.name || "");
	if (name === "bash" || name === "powershell") return { command: partial };
	if (name === "read" || name === "write" || name === "edit" || name === "ls") return { path: partial };
	return { query: partial };
}

export function locateStreamingToolCall(
	content: any[],
	streamEvent: any,
): { index: number; block: any } | undefined {
	const index = Number(streamEvent?.contentIndex);
	if (Number.isInteger(index) && content[index]?.type === "toolCall") {
		return { index, block: content[index] };
	}
	const fromEvent = streamEvent?.toolCall;
	if (fromEvent && (fromEvent.type === "toolCall" || fromEvent.name)) {
		const found = content.findIndex(
			(item) => item?.type === "toolCall" && fromEvent.id && item.id === fromEvent.id,
		);
		if (found >= 0) return { index: found, block: content[found] };
		return { index: Number.isInteger(index) ? index : content.length, block: fromEvent };
	}
	return undefined;
}

export function toolResultText(tool: any): string {
	return (tool?.result?.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => String(c.text))
		.join("\n")
		.trim();
}

export function formatWorkedTime(elapsedMs: number): string {
	const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

export function formatToolDuration(durationSec: number): string {
	const safeSec = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
	const ms = Math.round(safeSec * 1000);
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (safeSec < 10) {
		return `${safeSec.toFixed(2)}s`;
	}
	return `${safeSec.toFixed(1)}s`;
}

export function isCtrlI(data: string): boolean {
	// Ignore key release events to prevent accidental toggling on key up
	if (isKeyRelease(data)) {
		return false;
	}
	// In legacy terminals, Ctrl+I sends byte 0x09 ("\t"), identical to Tab.
	// To keep Tab completion working, exclude plain "\t" and only recognize
	// Ctrl+I under extended keyboard protocols (Kitty keyboard, modifyOtherKeys).
	return data !== "\t" && (parseKey(data) === "ctrl+i" || matchesKey(data, "ctrl+i"));
}
