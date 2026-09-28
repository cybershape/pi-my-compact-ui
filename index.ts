/**
 * compact-ui: collect thinking runs + tool calls into a single tree-shaped block.
 *
 * Tool calls are intercepted at the container-prototype level (like
 * pi-cc-extensions) and collected into a ToolGroupComponent rendered in place
 * in the transcript. Thinking is captured from message_update events; every run
 * is appended to the same block as its own entry.
 *
 * Entries are listed in stream order, oldest first, one line each. The entry
 * row spins while it is still streaming:
 *   ⠋ tool calling...
 *   │  ⠋ thinking: Planning the fix...
 *   │  ✓ bash: ls /tmp && cat fi... (3s)
 *   └  ✓ thinking: The cache is stale · 1.2K tok
 *
 * Ctrl+O toggles collapse/expand (via setExpanded, same as built-in tools).
 * Expand line counts are configurable via /compact-ui-config (interactive
 * settings menu, arrows to select, Enter to adjust, Esc to close) and are
 * persisted to ~/.pi/agent/compact-ui.json:
 *   { "expandedToolLines": 5, "expandedThinkingLines": 10 }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	CompactionSummaryMessageComponent,
	ToolExecutionComponent,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	getMarkdownTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	SettingsList,
	Spacer,
	Text,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, DefaultTextStyle, MarkdownTheme, SettingItem } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// =============================================================================
// Config
// =============================================================================
const CONFIG_PATH = join(homedir(), ".pi", "agent", "compact-ui.json");
const DEFAULT_CONFIG = { expandedToolLines: 5, expandedThinkingLines: 10 };
let config = { ...DEFAULT_CONFIG };
try {
	config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
} catch {
	// first run — use defaults
}

function saveConfig(): void {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
	} catch {
		// ignore
	}
}

// Interactive editor metadata for each numeric option.
const CONFIG_KEYS = [
	{
		id: "expandedToolLines",
		label: "Expanded tool lines",
		description: "Result lines shown per tool when expanded",
		min: 1,
		max: 50,
		step: 1,
	},
	{
		id: "expandedThinkingLines",
		label: "Expanded thinking lines",
		description: "Thinking lines shown when expanded",
		min: 1,
		max: 100,
		step: 1,
	},
] as const;

// Numeric stepper submenu: ◀/▶ (or −/+) adjust the value, Enter saves, Esc
// cancels. `done(undefined)` means "no change".
function makeStepper(
	title: string,
	initial: number,
	meta: { min: number; max: number; step: number },
	theme: any,
	done: (value?: string) => void,
): Component {
	let value = initial;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const fg = (color: string, t: string) => theme?.fg?.(color, t) ?? t;

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const barLen = Math.max(1, Math.min(width - 10, 40));
			const ratio = (value - meta.min) / Math.max(1, meta.max - meta.min);
			const filled = Math.round(ratio * barLen);
			const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
			const titleText = theme?.bold ? theme.bold(title) : title;
			cachedLines = [
				fg("accent", titleText),
				"",
				`  ${fg("accent", String(value))}`,
				`  ${fg("muted", bar)}`,
				"",
				fg("dim", "  ◀ ▶ / − +  adjust    Enter  save    Esc  cancel"),
			].map((line) => truncateToWidth(line, Math.max(1, width)));
			cachedWidth = width;
			return cachedLines;
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.down) || data === "-" || data === "_") {
				value = Math.max(meta.min, value - meta.step);
			} else if (matchesKey(data, Key.right) || matchesKey(data, Key.up) || data === "+" || data === "=") {
				value = Math.min(meta.max, value + meta.step);
			} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				done(String(value));
				return;
			} else if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
			cachedWidth = undefined;
		},
		invalidate(): void {
			cachedWidth = undefined;
		},
	};
}

// =============================================================================
// Shared state
// =============================================================================
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// 100ms/frame (10fps) matches pi's default spinner cadence; 300ms felt laggy.
const SPINNER_MS = 100;
const GROUP_PADDING_X = 1;
const spinnerStart = Date.now();
const PARENT_KEY = Symbol.for("compact-ui.group-parent");
const PATCH_KEY = Symbol.for("compact-ui.group-patch");
const MARKDOWN_RENDER_PATCH_KEY = Symbol.for("compact-ui.markdown-render-patch");
const COMPACTION_STYLE_PATCH_KEY = Symbol.for("compact-ui.compaction-style-patch");
const ASSISTANT_THINKING_PATCH_KEY = Symbol.for("compact-ui.assistant-thinking-patch");

// -----------------------------------------------------------------------------
// Compact block contents. A block is an ordered list of the exact items the
// model produced, interleaving thinking runs with tool calls. Thinking runs are
// never merged: each run keeps its own row (spinner while streaming, completion
// mark afterwards).
// -----------------------------------------------------------------------------
type ThinkingEntry = {
	kind: "thinking";
	id: number;
	text: string;
	tokens: number;
	tokensExact: boolean;
	/** Still streaming — renders the animated spinner instead of the done mark. */
	active: boolean;
	/** Group currently owning this entry, used for targeted invalidation. */
	owner: ToolGroupComponent | null;
};

type GroupEntry = { kind: "tool"; tool: any } | ThinkingEntry;

let currentTheme: any = null;
// The thinking run currently streaming, if any. thinking_end (or the visible
// text boundary that seals the block) finalizes it and clears this slot.
let activeThinking: ThinkingEntry | null = null;
// contentIndex of the streaming thinking block within the current assistant
// message, recorded so a late thinking_end for an already-sealed run is ignored.
let activeThinkingIndex: number | null = null;
// Cumulative text of the streaming run, keyed by content index.
const activeThinkingBlocks = new Map<number, string>();
// Runs created before their group exists (the assistant message component has
// not been added to the chat container yet). Drained by ensureThinkingGroup().
const unattachedThinking: ThinkingEntry[] = [];
// Stable per-run id, used as the Markdown preview cache key.
let thinkingEntrySeq = 0;
// message_update contains a cumulative AssistantMessage snapshot. Track stream
// content indexes so growing text deltas seal a block only once.
const handledTextIndexes = new Set<number>();
// Thinking content indexes already sealed in the current assistant message.
// Providers that finalize content blocks at the end of the stream
// (openai-completions pushes thinking_end after its delta loop) re-emit the
// block after the text; those repeats must not spawn a duplicate entry.
const sealedThinkingIndexes = new Set<number>();
let pendingTextSeal = false;
let pendingTextOrdinal: number | null = null;
let lastActiveGroup: ToolGroupComponent | null = null;
// Last finalized thinking run. Its token count is usually frozen before the
// provider reports reasoning usage, so the reported value is re-applied later.
let lastSealedThinkingEntry: ThinkingEntry | null = null;
let lastReportedReasoningTokens = 0;
// Track the current assistant message's component + the container it lives in,
// so a thinking-only group can be inserted right after it (before any tool).
let lastStreamingComp: any = null;
let lastChatContainer: any = null;
const toolStarts = new Map<string, number>();
// Wall-clock start of the current turn (user message), used to render the
// "worked for Xm Ys" divider before the final visible text.
let turnStartMs = 0;

// =============================================================================
// Tool summary helpers
// =============================================================================
function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function oneLine(value: unknown, max = 60): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function formatTokenK(tokens: number): string {
	if (tokens <= 0) return "0.0K";
	if (tokens < 100) return "<0.1K";
	const value = tokens / 1000;
	return value < 100 ? `${value.toFixed(1)}K` : `${Math.round(value)}K`;
}

function updateActiveThinkingTokens(message: any): void {
	const entry = activeThinking;
	if (!entry) return;
	entry.text = [...activeThinkingBlocks.values()].filter((text) => text.trim()).join("\n\n");
	// Most providers report reasoning usage only when the response finishes. While
	// streaming, fall back to pi's own chars/4 token heuristic and mark it with ≈.
	const reported = Number(message?.usage?.reasoning);
	if (Number.isFinite(reported) && reported > 0) {
		entry.tokens = reported;
		entry.tokensExact = true;
		lastReportedReasoningTokens = reported;
		return;
	}
	entry.tokens = estimateTextTokens(entry.text);
	entry.tokensExact = false;
}

function thinkingTokenLabel(entry: ThinkingEntry): string {
	return `${entry.tokensExact ? "" : "≈"}${formatTokenK(entry.tokens)} tok`;
}

function createThinkingEntry(): ThinkingEntry {
	const entry: ThinkingEntry = {
		kind: "thinking",
		id: thinkingEntrySeq++,
		text: "",
		tokens: 0,
		tokensExact: false,
		active: true,
		owner: null,
	};
	activeThinking = entry;
	activeThinkingBlocks.clear();
	unattachedThinking.push(entry);
	return entry;
}

// Close the streaming run. The entry keeps its text, so sealing a group never
// needs a separate snapshot; only the spinner has to stop.
function finalizeActiveThinking(): void {
	const entry = activeThinking;
	if (!entry) return;
	entry.active = false;
	entry.owner?.invalidate();
	if (activeThinkingIndex !== null) sealedThinkingIndexes.add(activeThinkingIndex);
	lastSealedThinkingEntry = entry;
	activeThinking = null;
	activeThinkingIndex = null;
	activeThinkingBlocks.clear();
}

// The entry is finalized at the text boundary, which usually happens before the
// provider reports exact reasoning usage (and before pi reads it off the
// finished message). Re-apply the reported value so the row stops showing a
// stale ≈ estimate for the rest of the turn.
function refreshSealedThinkingTokens(reportedReasoning?: unknown): void {
	const reported = Number(reportedReasoning);
	if (Number.isFinite(reported) && reported > 0) lastReportedReasoningTokens = reported;
	const entry = lastSealedThinkingEntry;
	if (!entry || entry.tokensExact) return;
	if (!entry.text.trim()) return; // no thinking row to correct
	if (!(lastReportedReasoningTokens > 0)) return;
	entry.tokens = lastReportedReasoningTokens;
	entry.tokensExact = true;
	entry.owner?.invalidate();
	capturedTui?.requestRender?.();
}

function toolSummary(name: string, args: any): { name: string; content: string } {
	switch (name) {
		case "bash":
			return { name: "bash", content: oneLine(args?.command || "…") };
		case "read":
			return { name: "read", content: shortenPath(args?.path || "…") };
		case "write":
		case "edit":
			return { name, content: shortenPath(args?.path || "…") };
		case "find":
			return { name: "find", content: `${oneLine(args?.pattern || "")} in ${shortenPath(args?.path || ".")}` };
		case "grep":
			return { name: "grep", content: `${oneLine(args?.pattern || "")} in ${shortenPath(args?.path || ".")}` };
		case "ls":
			return { name: "ls", content: shortenPath(args?.path || ".") };
		case "web_search":
			return { name: "web_search", content: oneLine(args?.query || "…") };
		case "subagent":
			return { name: "subagent", content: oneLine(args?.agent || args?.task || "…") };
		default: {
			const preferred = args?.path ?? args?.query ?? args?.name ?? args?.description ?? args?.url;
			return { name, content: oneLine(preferred ?? "…") };
		}
	}
}

type ToolStatus = "pending" | "success" | "error";
function toolStatus(tool: any): ToolStatus {
	if (tool?.result?.isError) return "error";
	if (tool?.isPartial === true || (tool?.executionStarted && !tool?.result)) return "pending";
	return tool?.result ? "success" : "pending";
}

function toolElapsed(tool: any): string {
	const start = toolStarts.get(tool.toolCallId) ?? Date.now();
	const end = tool?.result ? tool._groupEndAt ?? Date.now() : Date.now();
	return ((end - start) / 1000).toFixed(1);
}

function toolResultText(tool: any): string {
	return (tool?.result?.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => String(c.text))
		.join("\n")
		.trim();
}

type MarkdownPreview = {
	source: string;
	width: number;
	maxLines: number;
	lines: string[];
	truncated: boolean;
};

// Compact code fence markers are exactly "┌─" or "┌─ <language>", and the
// close row is exactly "└─". Markdown tables reuse the same box-drawing
// prefix ("┌─────┬──────┐") and must not enter code-block mode.
function isCompactCodeBlockOpen(visible: string): boolean {
	return visible === "┌─" || visible.startsWith("┌─ ");
}

function isCompactCodeBlockClose(visible: string): boolean {
	return visible === "└─";
}

// Pi's Markdown component normally renders fenced code blocks with literal
// ``` delimiters. Emit lightweight internal markers here; the normalization
// pass replaces them with a padded, theme-aware background block while
// retaining syntax highlighting.
export function getCompactMarkdownTheme(): MarkdownTheme {
	const base = getMarkdownTheme();
	let insideCodeBlock = false;
	const theme: MarkdownTheme = {
		...base,
		codeBlockIndent: "",
		codeBlockBorder(text: string): string {
			const opening = !insideCodeBlock;
			insideCodeBlock = !insideCodeBlock;
			const language = opening ? text.replace(/^```/, "").trim() : "";
			if (opening) {
				theme.codeBlockIndent = "";
			}
			const border = opening ? `┌─${language ? ` ${language}` : ""}` : "└─";
			return base.codeBlockBorder(border);
		},
	};
	return theme;
}

const CODE_BLOCK_PADDING_X = 1;

function renderCodeBlockBackgroundRow(content: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const horizontalPadding = Math.min(CODE_BLOCK_PADDING_X, Math.floor((safeWidth - 1) / 2));
	const innerWidth = Math.max(1, safeWidth - horizontalPadding * 2);
	const clipped = truncateToWidth(content, innerWidth, "…");
	const rightFill = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const row = `${" ".repeat(horizontalPadding)}${clipped}${rightFill}${" ".repeat(horizontalPadding)}`;
	return currentTheme?.bg?.("toolPendingBg", row) ?? row;
}

export function normalizeCompactCodeBlockLines(lines: string[], width: number, paddingX = 0): string[] {
	const safeWidth = Math.max(1, width);
	const horizontalPadding = Math.max(0, Math.floor(paddingX));
	const leftPadding = " ".repeat(horizontalPadding);
	const contentWidth = Math.max(1, safeWidth - horizontalPadding * 2);
	const continuationWidth = contentWidth;
	const normalized: string[] = [];
	let codeBlockMode: "none" | "background" = "none";

	for (const originalLine of lines) {
		const withoutLeftPadding =
			leftPadding.length > 0 && originalLine.startsWith(leftPadding)
				? originalLine.slice(leftPadding.length)
				: originalLine;
		const content = withoutLeftPadding.trimEnd();
		const visible = stripTerminalSequences(content).trimStart();
		if (isCompactCodeBlockOpen(visible)) {
			codeBlockMode = "background";
			const language = visible.replace(/^┌─/, "").trim();
			if (language) {
				const label = currentTheme?.fg?.("muted", language) ?? language;
				normalized.push(`${leftPadding}${renderCodeBlockBackgroundRow(label, contentWidth)}`);
			}
			continue;
		}
		if (isCompactCodeBlockClose(visible)) {
			codeBlockMode = "none";
			continue;
		}
		if (codeBlockMode === "background") {
			const codeWidth = Math.max(1, continuationWidth - CODE_BLOCK_PADDING_X * 2);
			const wrappedRows = wrapTextWithAnsi(content, codeWidth);
			for (const wrapped of wrappedRows.length > 0 ? wrappedRows : [""]) {
				normalized.push(`${leftPadding}${renderCodeBlockBackgroundRow(wrapped, contentWidth)}`);
			}
			continue;
		}
		normalized.push(truncateToWidth(originalLine, safeWidth, "…"));
	}

	return normalized;
}

// AssistantMessageComponent already uses Markdown for visible final text, but
// pi's stock Markdown theme intentionally displays literal ``` fence rows.
// Replace only visible assistant Markdown instances with compact code borders;
// user/custom messages and hidden thinking Markdown retain their native theme.
function installVisibleAssistantMarkdownRendering(component: Markdown): void {
	const markdown = component as any;
	if (markdown[MARKDOWN_RENDER_PATCH_KEY]) return;
	markdown.theme = getCompactMarkdownTheme();
	const originalRender = markdown.render.bind(markdown);
	markdown.render = (width: number): string[] =>
		normalizeCompactCodeBlockLines(originalRender(width), width, Number(markdown.paddingX) || 0);
	markdown[MARKDOWN_RENDER_PATCH_KEY] = { originalRender };
	markdown.invalidate();
}

class CompactionHeaderComponent implements Component {
	constructor(private readonly tokensBefore: number) {}

	render(width: number): string[] {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const exactTokens = Math.max(0, this.tokensBefore).toLocaleString();
		const icon = fg("success", "›‹");
		const title = fg("success", "Context compacted");
		const detail = fg("muted", ` • ${exactTokens} tokens → summary`);
		const full = `${icon} ${title}${detail}`;
		if (visibleWidth(full) <= width) return [full];

		const compactTitle = fg("success", "Compacted");
		const compactDetail = fg("muted", ` • ${formatTokenK(this.tokensBefore)} tok`);
		return [truncateToWidth(`${icon} ${compactTitle}${compactDetail}`, Math.max(1, width), "…")];
	}

	invalidate(): void {}
}

function installCompactionSummaryRendering(): void {
	const prototype = CompactionSummaryMessageComponent.prototype as any;
	const previous = prototype[COMPACTION_STYLE_PATCH_KEY] as
		| {
				original?: (this: any) => void;
				installed?: (this: any) => void;
				originalUpdateDisplay?: (this: any) => void;
				originalSetExpanded?: (this: any, expanded: boolean) => void;
				installedUpdateDisplay?: (this: any) => void;
				installedSetExpanded?: (this: any, expanded: boolean) => void;
		  }
		| undefined;
	// Replace the previous compact-ui closure on hot reload while retaining
	// pi's original renderer for a future replacement.
	const previousInstalledUpdate = previous?.installedUpdateDisplay ?? previous?.installed;
	const originalUpdateDisplay =
		previous && previousInstalledUpdate && prototype.updateDisplay === previousInstalledUpdate
			? (previous.originalUpdateDisplay ?? previous.original)!
			: (prototype.updateDisplay as (this: any) => void);
	const originalSetExpanded =
		previous?.installedSetExpanded && prototype.setExpanded === previous.installedSetExpanded
			? previous.originalSetExpanded!
			: (prototype.setExpanded as (this: any, expanded: boolean) => void);
	const installedUpdateDisplay = function (this: any): void {
		this.paddingX = GROUP_PADDING_X;
		this.paddingY = 0;
		this.setBgFn(undefined);
		this.clear();

		const tokensBefore = Number(this.message?.tokensBefore);
		const safeTokens = Number.isFinite(tokensBefore) && tokensBefore > 0 ? tokensBefore : 0;
		this.addChild(new CompactionHeaderComponent(safeTokens));
	};
	const installedSetExpanded = function (this: any, _expanded: boolean): void {
		// Context compaction is a static transcript event. Global Ctrl+O remains
		// available for compact thinking/tool groups but does not alter this row.
	};
	prototype.updateDisplay = installedUpdateDisplay;
	prototype.setExpanded = installedSetExpanded;
	prototype[COMPACTION_STYLE_PATCH_KEY] = {
		originalUpdateDisplay,
		originalSetExpanded,
		installedUpdateDisplay,
		installedSetExpanded,
	};
}

/**
 * Pi's hidden-thinking mode still renders one Text component per thinking run.
 * Setting its label to "" hides the glyphs, but the Text itself still occupies
 * a terminal row and Pi may add adjacent Spacer components around it.
 *
 * compact-ui already renders thinking inside ToolGroupComponent, so remove
 * thinking blocks from the presentation-only message passed to Pi's native
 * AssistantMessageComponent. The original session/model message is untouched,
 * and visible text/tool-call ordering is preserved.
 */
function installNativeThinkingSuppression(): void {
	const prototype = AssistantMessageComponent.prototype as any;
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
		const content = Array.isArray(message?.content) ? message.content : undefined;
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
	};
	prototype.updateContent = installedUpdateContent;
	prototype[ASSISTANT_THINKING_PATCH_KEY] = {
		originalUpdateContent,
		installedUpdateContent,
	};
}

// =============================================================================
// ToolGroupComponent
// =============================================================================
class ToolGroupComponent extends Container {
	readonly toolCallId = `compact-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	toolName = "group";
	/** Nested at a visible-text boundary rather than rendered at chat level. */
	anchored = false;
	private _expanded = false;
	get expanded(): boolean {
		return this._expanded;
	}
	/** Sealed: this block was closed by real text output — no further entries. */
	sealed = false;
	/** Thinking runs and tool calls, in the exact order they streamed in. */
	entries: GroupEntry[] = [];
	private markdownPreviewCache = new Map<string, MarkdownPreview>();

	constructor() {
		super();
	}

	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		for (const tool of this.children as any[]) tool.setExpanded?.(expanded);
		this.invalidate();
	}

	addTool(tool: any): void {
		this.children.push(tool);
		if ((tool as any)._groupedAt === undefined) (tool as any)._groupedAt = Date.now();
		(tool as any)[PARENT_KEY] = this;
		this.entries.push({ kind: "tool", tool });
	}

	/** Append a thinking run. Idempotent: a run belongs to exactly one group. */
	addThinking(entry: ThinkingEntry): void {
		if (entry.owner) return;
		entry.owner = this;
		this.entries.push(entry);
	}

	removeTool(tool: any): void {
		const index = this.children.indexOf(tool);
		if (index >= 0) this.children.splice(index, 1);
		const entryIndex = this.entries.findIndex((item) => item.kind === "tool" && item.tool === tool);
		if (entryIndex >= 0) this.entries.splice(entryIndex, 1);
		if ((tool as any)?.[PARENT_KEY] === this) delete (tool as any)[PARENT_KEY];
	}

	/** Return only entries that should be displayed (tools, or thinking with non-empty text). */
	getVisibleEntries(): GroupEntry[] {
		return this.entries.filter((entry) => {
			if (entry.kind === "tool") return true;
			if (entry.kind === "thinking") {
				return entry.text.trim().length > 0;
			}
			return false;
		});
	}

	hasVisibleEntries(): boolean {
		return this.getVisibleEntries().length > 0;
	}

	hasPending(): boolean {
		return this.getVisibleEntries().some((entry) => entry.kind === "tool" && toolStatus(entry.tool) === "pending");
	}

	/** True while a thinking run in this group is still streaming. */
	hasActiveThinking(): boolean {
		return this.getVisibleEntries().some((entry) => entry.kind === "thinking" && entry.active);
	}

	/** True once any thinking run has been added to this group. */
	hasThinking(): boolean {
		return this.getVisibleEntries().some((entry) => entry.kind === "thinking");
	}

	/** True while this group should keep its spinner animating. */
	needsAnimation(): boolean {
		return this.hasVisibleEntries() && (this.hasPending() || this.hasActiveThinking());
	}

	override invalidate(): void {
		// Theme changes and tool/thinking updates must rebuild ANSI markdown.
		this.markdownPreviewCache.clear();
		super.invalidate();
	}

	private renderMarkdownPreview(
		cacheKey: string,
		source: string,
		width: number,
		maxLines: number,
		defaultTextStyle?: DefaultTextStyle,
	): MarkdownPreview {
		const renderWidth = Math.max(1, width);
		const lineLimit = Math.max(1, maxLines);
		const cached = this.markdownPreviewCache.get(cacheKey);
		if (cached && cached.source === source && cached.width === renderWidth && cached.maxLines === lineLimit) {
			return cached;
		}

		// Only a bounded prefix can become visible. This prevents a very large
		// command result from being reparsed in full merely to display a handful
		// of expanded lines. Incomplete closing fences are supported by pi-tui.
		const sourceRows = source.split("\n");
		const sourceLineLimit = Math.max(lineLimit * 4, lineLimit + 20);
		const sourceCharLimit = Math.max(4096, lineLimit * Math.max(40, renderWidth) * 4);
		let markdownSource = sourceRows.slice(0, sourceLineLimit).join("\n");
		let sourceTruncated = sourceRows.length > sourceLineLimit;
		if (markdownSource.length > sourceCharLimit) {
			markdownSource = markdownSource.slice(0, sourceCharLimit);
			sourceTruncated = true;
		}

		const markdown = new Markdown(markdownSource, 0, 0, getCompactMarkdownTheme(), defaultTextStyle);
		const rendered = normalizeCompactCodeBlockLines(markdown.render(renderWidth), renderWidth);
		const preview: MarkdownPreview = {
			source,
			width: renderWidth,
			maxLines: lineLimit,
			lines: rendered.slice(0, lineLimit),
			truncated: sourceTruncated || rendered.length > lineLimit,
		};
		this.markdownPreviewCache.set(cacheKey, preview);
		return preview;
	}

	private iconFor(tool: any, frame: string): string {
		const st = toolStatus(tool);
		return st === "pending" ? frame : st === "error" ? "✗" : "✓";
	}
	private colorFor(status: string): string {
		return status === "pending" ? "accent" : status === "error" ? "error" : "success";
	}
	// Tool name in bold accent, tool payload in dim.
	private toolRow(rail: string, tool: any, frame: string): string {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const bold = theme?.bold ? theme.bold : (t: string) => t;
		const st = toolStatus(tool);
		const s = toolSummary(tool.toolName, tool.args);
		const prefix = rail ? fg("dim", rail) : "";
		return `${prefix}${fg(this.colorFor(st), this.iconFor(tool, frame))} ${fg("toolTitle", bold(s.name))} ${fg("dim", s.content)} ${fg("muted", `(${toolElapsed(tool)}s)`)}`;
	}

	// One row per thinking run. The spinner marks the run that is still streaming;
	// the completion mark is written as soon as the run ends.
	private thinkingRow(rail: string, entry: ThinkingEntry, frame: string, width: number): string {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const icon = entry.active ? frame : "✓";
		const preview = entry.text.trim().replace(/[*_#`>]+/g, "");
		const prefix = rail ? fg("dim", rail) : "";
		if (!preview) {
			const label = entry.active ? "thinking..." : "thinking";
			return `${prefix}${fg("thinkingText", icon)} ${fg("thinkingText", label)}`;
		}
		const tokenLabel = thinkingTokenLabel(entry);
		const previewLimit = Math.max(1, Math.min(60, width - GROUP_PADDING_X - rail.length - 18 - tokenLabel.length));
		return `${prefix}${fg("thinkingText", icon)} ${fg("thinkingText", `thinking: ${oneLine(preview, previewLimit)}`)} ${fg("muted", `· ${tokenLabel}`)}`;
	}

	// Folded: header + one line per entry, in stream order (oldest first).
	// When there is only 1 visible entry, do not show hierarchy (no header, no tree rail).
	private renderCollapsed(width: number, visible: GroupEntry[]): string[] {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;

		if (visible.length === 1) {
			const entry = visible[0]!;
			if (entry.kind === "tool") {
				return [this.toolRow("", entry.tool, frame)];
			}
			return [this.thinkingRow("", entry, frame, width)];
		}

		const lines: string[] = [];

		const hasPendingTool = visible.some((e) => e.kind === "tool" && toolStatus(e.tool) === "pending");
		const isThinking = !this.sealed && visible.some((e) => e.kind === "thinking" && e.active);
		const hasTools = visible.some((e) => e.kind === "tool");
		const hasThinking = visible.some((e) => e.kind === "thinking");
		const openNoTools = !this.sealed && !hasTools;
		const working = hasPendingTool || isThinking || openNoTools;
		const state = hasPendingTool
			? "tool calling..."
			: !hasTools
				? working
					? "thinking..."
					: "thinking"
				: isThinking
					? "thinking..."
					: hasThinking
						? "tools and thinking done"
						: "tools done";
		const stateColor = hasPendingTool ? "accent" : hasTools && !isThinking ? "success" : "thinkingText";
		// Left icon: spinner while working, completion mark once the group is done.
		const leftIcon = working ? frame : "✓";
		lines.push(`${fg(stateColor, leftIcon)} ${fg(stateColor, state)}`);

		// Every entry is shown, one line each, in the order the model produced it.
		const total = visible.length;
		for (let index = 0; index < total; index++) {
			const entry = visible[index]!;
			const rail = index === total - 1 ? "└  " : "│  ";
			lines.push(
				entry.kind === "thinking"
					? this.thinkingRow(rail, entry, frame, width)
					: this.toolRow(rail, entry.tool, frame),
			);
		}

		return lines;
	}

	// Expanded: per-tool detail + every thinking run, in stream order.
	// When there is only 1 visible entry, do not show hierarchy (no header, no tree rail).
	private renderExpanded(width: number, visible: GroupEntry[]): string[] {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;
		const lines: string[] = [];

		if (visible.length === 1) {
			const entry = visible[0]!;
			const sub = "  ";
			if (entry.kind === "tool") {
				const tool = entry.tool;
				lines.push(this.toolRow("", tool, frame));
				const result = toolResultText(tool);
				if (result) {
					const markdownWidth = Math.max(1, width - GROUP_PADDING_X - sub.length);
					const preview = this.renderMarkdownPreview(
						`tool:${tool.toolCallId ?? 0}`,
						result,
						markdownWidth,
						config.expandedToolLines,
						{ color: (text) => currentTheme?.fg?.("toolOutput", text) ?? text },
					);
					for (const row of preview.lines) {
						lines.push(`${fg("dim", sub)}${row}`);
					}
					if (preview.truncated) {
						lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
					}
				}
				return lines;
			}

			const icon = entry.active ? frame : "✓";
			lines.push(
				`${fg("thinkingText", icon)} ${fg("thinkingText", "thinking")} ${fg("muted", `· ${thinkingTokenLabel(entry)}`)}`,
			);
			const tText = entry.text.trim();
			if (tText) {
				const markdownWidth = Math.max(1, width - GROUP_PADDING_X - sub.length);
				const preview = this.renderMarkdownPreview(
					`thinking:${entry.id}`,
					tText,
					markdownWidth,
					config.expandedThinkingLines,
					{ color: (text) => currentTheme?.fg?.("thinkingText", text) ?? text, italic: true },
				);
				for (const row of preview.lines) {
					lines.push(`${fg("dim", sub)}${row}`);
				}
				if (preview.truncated) {
					lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
				}
			}
			return lines;
		}

		const hasPendingTool = visible.some((e) => e.kind === "tool" && toolStatus(e.tool) === "pending");
		const isThinking = !this.sealed && visible.some((e) => e.kind === "thinking" && e.active);
		// See renderCollapsed: a block without tools keeps the thinking label, and a
		// block with reasoning must not claim "tools done" alone.
		const hasTools = visible.some((e) => e.kind === "tool");
		const hasThinking = visible.some((e) => e.kind === "thinking");
		const openNoTools = !this.sealed && !hasTools;
		const working = hasPendingTool || isThinking || openNoTools;
		const state = hasPendingTool
			? "tool calling..."
			: !hasTools
				? working
					? "thinking..."
					: "thinking"
				: isThinking
					? "thinking..."
					: hasThinking
						? "tools and thinking done"
						: "tools done";
		const stateColor = hasPendingTool ? "accent" : hasTools && !isThinking ? "success" : "thinkingText";
		// Left icon: spinner while working, completion mark once the group is done.
		const leftIcon = working ? frame : "✓";
		lines.push(`${fg(stateColor, leftIcon)} ${fg(stateColor, state)}`);

		const total = visible.length;
		for (let index = 0; index < total; index++) {
			const entry = visible[index]!;
			const isLast = index === total - 1;
			const rail = isLast ? "└─ " : "├─ ";
			const sub = isLast ? "    " : "│   ";
			if (entry.kind === "tool") {
				const tool = entry.tool;
				lines.push(this.toolRow(rail, tool, frame));
				const result = toolResultText(tool);
				if (result) {
					const markdownWidth = Math.max(1, width - GROUP_PADDING_X - sub.length);
					const preview = this.renderMarkdownPreview(
						`tool:${tool.toolCallId ?? index}`,
						result,
						markdownWidth,
						config.expandedToolLines,
						{ color: (text) => currentTheme?.fg?.("toolOutput", text) ?? text },
					);
					for (const row of preview.lines) {
						lines.push(`${fg("dim", sub)}${row}`);
					}
					if (preview.truncated) {
						lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
					}
				}
				continue;
			}

			const icon = entry.active ? frame : "✓";
			lines.push(
				`${fg("dim", rail)}${fg("thinkingText", icon)} ${fg("thinkingText", "thinking")} ${fg("muted", `· ${thinkingTokenLabel(entry)}`)}`,
			);
			const tText = entry.text.trim();
			if (!tText) continue;
			const markdownWidth = Math.max(1, width - GROUP_PADDING_X - sub.length);
			const preview = this.renderMarkdownPreview(
				`thinking:${entry.id}`,
				tText,
				markdownWidth,
				config.expandedThinkingLines,
				{ color: (text) => currentTheme?.fg?.("thinkingText", text) ?? text, italic: true },
			);
			for (const row of preview.lines) {
				lines.push(`${fg("dim", sub)}${row}`);
			}
			if (preview.truncated) {
				lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
			}
		}

		return lines;
	}

	override render(width: number): string[] {
		const visible = this.getVisibleEntries();
		if (visible.length === 0) return [];

		if (this.needsAnimation()) scheduleAnimation();

		const lines = this._expanded ? this.renderExpanded(width, visible) : this.renderCollapsed(width, visible);
		if (lines.length === 0) return [];
		// Indent compact blocks from the transcript edge while keeping every line
		// within the terminal width (including mobile / narrow terminals).
		const padding = " ".repeat(Math.min(GROUP_PADDING_X, Math.max(0, width - 1)));
		const contentWidth = Math.max(1, width - padding.length);
		const rendered = lines.map((line) => padding + truncateToWidth(line, contentWidth, "…"));
		// Native ToolExecutionComponent starts with Spacer(1). Our custom render
		// bypasses that child tree, so restore the same single leading gap while
		// the group is top-level. Anchored groups receive deterministic spacing
		// from placeAnchoredGroupBeforeText() instead.
		return this.anchored ? rendered : ["", ...rendered];
	}
}

// =============================================================================
// Animation scheduling. The TUI instance is captured via setWidget's factory
// (extensions can't requestRender directly). We tick at 300ms and call the
// throttled requestRender(), so the diff renderer updates only the changed
// spinner/elapsed cells — no full-screen repaint, no scroll fight.
// =============================================================================
let animTimer: ReturnType<typeof setTimeout> | null = null;
let capturedTui: any = null;

function scheduleAnimation(): void {
	if (animTimer) return;
	animTimer = setTimeout(() => {
		animTimer = null;
		let any = false;
		for (const g of groups) {
			if (g.needsAnimation()) {
				any = true;
				break;
			}
		}
		if (any && capturedTui) {
			capturedTui.requestRender();
		}
	}, SPINNER_MS);
}

// =============================================================================
// Prototype patch
// =============================================================================
const groups = new Set<ToolGroupComponent>();

function isGroupable(value: any): boolean {
	return value instanceof ToolExecutionComponent;
}

function previousGroupable(children: any[], start: number): { child: any; index: number } | undefined {
	for (let i = start; i >= 0; i--) {
		const child = children[i];
		if (child instanceof Spacer) continue;
		if (child instanceof AssistantMessageComponent) continue;
		return { child, index: i };
	}
	return undefined;
}

// A thinking run appears in the transcript as soon as it starts, even before its
// first delta, so its row can spin while the model is still reasoning. The block
// is inserted right after the current assistant message component so the
// message's (and later messages') tool calls join it via maybeGroup — as long as
// no real (non-thinking) text sealed it in between.
function ensureThinkingGroup(): void {
	if (unattachedThinking.length === 0) return;
	let group = lastActiveGroup && !lastActiveGroup.sealed ? lastActiveGroup : null;
	if (!group) {
		if (!lastChatContainer || !lastStreamingComp) return; // retry on the next event
		const parent = lastChatContainer;
		const children = parent.children;
		if (!Array.isArray(children)) return;
		const idx = children.indexOf(lastStreamingComp);
		group = new ToolGroupComponent();
		children.splice(idx >= 0 ? idx + 1 : children.length, 0, group);
		groups.add(group);
		lastActiveGroup = group;
		parent.invalidate?.();
	}
	while (unattachedThinking.length > 0) group.addThinking(unattachedThinking.shift()!);
	group.invalidate();
	capturedTui?.requestRender?.();
}

// A text stream is a boundary between compact blocks. The message_update event
// arrives before or after the matching AssistantMessageComponent depending on
// the renderer's event ordering, so defer the seal until that component exists.
function flushPendingTextSeal(): void {
	if (!pendingTextSeal) return;

	// A run still streaming when the answer starts belongs to the block being
	// sealed, and may not have a group yet.
	if (activeThinking || unattachedThinking.length > 0) ensureThinkingGroup();

	if (lastActiveGroup && !lastActiveGroup.sealed) {
		// The active group contains every thinking/tool event since the previous
		// visible text. Anchor it immediately before this text block so the visual
		// component order matches the stream order:
		//   group -> visible text -> next group -> next visible text
		if (lastActiveGroup.hasVisibleEntries()) {
			if (pendingTextOrdinal !== null) {
				anchorGroupBeforeCurrentText(lastActiveGroup, pendingTextOrdinal);
			}
		} else {
			if (lastChatContainer) removeGroupFromContainer(lastChatContainer, lastActiveGroup);
			groups.delete(lastActiveGroup);
		}
		lastActiveGroup.sealed = true;
		finalizeActiveThinking();
		lastActiveGroup.invalidate();
		pendingTextSeal = false;
		pendingTextOrdinal = null;
		return;
	}

	// No thinking or tools preceded this text, so there is no compact block to
	// seal. Do not let the boundary leak forward and close a later tool group.
	pendingTextSeal = false;
	pendingTextOrdinal = null;
}

function maybeGroup(parent: any, component: any): void {
	if (!isGroupable(component) || parent instanceof ToolGroupComponent) return;
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index < 0) return;
	const prior = previousGroupable(children, index - 1);

	// Previous sibling is an open (not-yet-sealed) group → join it.
	if (prior?.child instanceof ToolGroupComponent && !prior.child.sealed) {
		children.splice(index, 1);
		prior.child.addTool(component);
		lastActiveGroup = prior.child;
		return;
	}
	// Previous sibling is a bare tool → merge both into a new group.
	if (prior && isGroupable(prior.child)) {
		const group = new ToolGroupComponent();
		group.addTool(prior.child);
		group.addTool(component);
		(parent as any).children[prior.index] = group;
		children.splice(index, 1);
		groups.add(group);
		lastActiveGroup = group;
		return;
	}
	// Otherwise (sealed group before, or nothing groupable) → wrap the tool in a
	// fresh open group so it stays visible.
	const group = new ToolGroupComponent();
	group.addTool(component);
	(parent as any).children[index] = group;
	groups.add(group);
	lastActiveGroup = group;
}

type PatchState = {
	active: boolean;
	original: { addChild: Function; removeChild: Function; clear: Function };
	installed: { addChild: Function; removeChild: Function; clear: Function };
	prototype: any;
};

// AssistantMessageComponent content containers that may carry a "phantom" blank
// line. With hiddenThinkingLabel set to "", pi still adds
// Text(italic(fg("thinkingText",""))) to the message; because the empty string
// is wrapped in ANSI escapes, Text does not treat it as empty and renders a full
// blank line. That phantom line (plus the thinking-only Spacer pi adds after
// it) makes the gap between a folded tool group and the following text look too
// large. We strip the empty Text so only pi's normal single Spacer remains.
const assistantContentContainers = new WeakSet<Container>();
type AssistantContentState = {
	/** Sealed groups keyed by the visible Markdown block they precede. */
	anchors: Map<number, ToolGroupComponent>;
	/** Visible Markdown ordinal while AssistantMessageComponent rebuilds. */
	nextTextOrdinal: number;
	/** Turn-duration divider bound to the final visible Markdown ordinal. */
	finalDivider?: { ordinal: number; component: any };
};
const assistantContentStates = new WeakMap<Container, AssistantContentState>();
const groupAnchors = new WeakMap<ToolGroupComponent, { container: Container; ordinal: number }>();

function getAssistantContentState(container: Container): AssistantContentState {
	let state = assistantContentStates.get(container);
	if (!state) {
		state = { anchors: new Map(), nextTextOrdinal: 0 };
		assistantContentStates.set(container, state);
	}
	return state;
}

function removeGroupFromContainer(container: any, group: ToolGroupComponent): void {
	const children = container?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(group);
	if (index >= 0) children.splice(index, 1);
}

function removeComponentFromContainer(container: any, component: any): void {
	const children = container?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index >= 0) children.splice(index, 1);
}

function formatWorkedTime(elapsedMs: number): string {
	const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

// Static horizontal rule with the turn's elapsed time in the middle:
//   ──── worked for 0m 42s ────
class TurnDividerComponent {
	private readonly timeLabel: string;

	constructor(timeLabel: string) {
		this.timeLabel = timeLabel;
	}

	render(width: number): string[] {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const middle = `worked for ${this.timeLabel}`;
		const avail = Math.max(6, width - middle.length - 2);
		const left = Math.floor(avail / 2);
		const right = avail - left;
		const dash = (n: number) => "─".repeat(Math.max(0, n));
		const line = `${fg("dim", dash(left))} ${fg("muted", middle)} ${fg("dim", dash(right))}`;
		return [truncateToWidth(line, Math.max(1, width))];
	}

	invalidate(): void {}
}

// Insert the turn divider directly before the final visible Markdown, keeping
// the anchored group's trailing Spacer as the gap: ... group, Spacer, divider,
// final text. Re-inserting is idempotent (the old instance is removed first).
function placeTurnDividerBeforeText(container: Container, target: Markdown, divider: any): void {
	const targetIndex = container.children.indexOf(target);
	if (targetIndex < 0) return;
	removeComponentFromContainer(container, divider);
	container.children.splice(targetIndex, 0, divider);
}

// Called at agent_end: bind a divider to the final visible text of the last
// assistant message so it survives cumulative rebuilds (like anchored groups).
function insertTurnDivider(elapsedMs: number): void {
	if (elapsedMs < 1000) return;
	let comp: any = lastStreamingComp;
	if (!comp || !(comp instanceof AssistantMessageComponent)) {
		if (!lastChatContainer) return;
		const children = (lastChatContainer as any)?.children;
		if (!Array.isArray(children)) return;
		for (let i = children.length - 1; i >= 0; i--) {
			if (children[i] instanceof AssistantMessageComponent) {
				comp = children[i];
				break;
			}
		}
	}
	if (!comp) return;
	const contentContainer = (comp as any).contentContainer;
	if (!(contentContainer instanceof Container)) return;

	const markdowns = contentContainer.children.filter(isVisibleTextMarkdown);
	if (markdowns.length === 0) return;
	const final = markdowns[markdowns.length - 1];
	const finalIndex = contentContainer.children.indexOf(final);
	// Only separate the final text from preceding work (an anchored tool/thinking
	// group). A plain text-only answer gets no divider.
	const hasPriorContent = contentContainer.children
		.slice(0, finalIndex)
		.some((child) => child instanceof ToolGroupComponent && child.hasVisibleEntries());
	if (!hasPriorContent) return;

	const state = getAssistantContentState(contentContainer);
	if (state.finalDivider && contentContainer.children.includes(state.finalDivider.component)) return;
	const ordinal = markdowns.length - 1;
	const divider = new TurnDividerComponent(formatWorkedTime(elapsedMs));
	state.finalDivider = { ordinal, component: divider };
	placeTurnDividerBeforeText(contentContainer, final, divider);
	contentContainer.invalidate?.();
	capturedTui?.requestRender?.();
}

function isVisibleTextMarkdown(component: any): component is Markdown {
	// Thinking Markdown receives a defaultTextStyle ({ color, italic }) from
	// AssistantMessageComponent; normal assistant text does not. Count only
	// normal text blocks so anchors remain correct if thinking visibility is
	// toggled on.
	return component instanceof Markdown && !(component as any).defaultTextStyle;
}

function placeAnchoredGroupBeforeText(container: Container, target: Markdown, group: ToolGroupComponent): void {
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
	while (spacerStart > 0 && container.children[spacerStart - 1] instanceof Spacer) spacerStart--;
	if (targetIndex > spacerStart) {
		container.children.splice(spacerStart, targetIndex - spacerStart);
	}
	group.anchored = true;
	container.children.splice(spacerStart, 0, new Spacer(1), group, new Spacer(1));
}

function insertAnchoredGroup(container: Container, ordinal: number, group: ToolGroupComponent): void {
	if (!group.hasVisibleEntries()) return;
	const markdowns = container.children.filter(isVisibleTextMarkdown);
	const target = markdowns[ordinal];
	if (!target) return;
	removeGroupFromContainer(container, group);
	placeAnchoredGroupBeforeText(container, target, group);
}

function installAssistantExpansion(component: AssistantMessageComponent, contentContainer: Container): void {
	// Ctrl+O only visits top-level chat children. Once compact groups are
	// anchored inside an AssistantMessageComponent, make that top-level
	// component expandable and delegate the state to its nested groups.
	(component as any).setExpanded = (expanded: boolean) => {
		const state = assistantContentStates.get(contentContainer);
		if (!state) return;
		for (const group of state.anchors.values()) group.setExpanded(expanded);
		contentContainer.invalidate();
	};
}

function anchorGroupBeforeCurrentText(group: ToolGroupComponent, ordinal: number): void {
	if (!lastStreamingComp || !lastChatContainer) return;
	const contentContainer = (lastStreamingComp as any).contentContainer;
	if (!(contentContainer instanceof Container)) return;

	// An open group normally lives directly in the chat container. Remove it
	// there before nesting it at the exact text boundary.
	removeGroupFromContainer(lastChatContainer, group);

	const previousAnchor = groupAnchors.get(group);
	if (previousAnchor) {
		const previousState = assistantContentStates.get(previousAnchor.container);
		if (previousState?.anchors.get(previousAnchor.ordinal) === group) {
			previousState.anchors.delete(previousAnchor.ordinal);
		}
		removeGroupFromContainer(previousAnchor.container, group);
	}

	if (!group.hasVisibleEntries()) {
		groups.delete(group);
		return;
	}

	const state = getAssistantContentState(contentContainer);
	const replaced = state.anchors.get(ordinal);
	if (replaced && replaced !== group) {
		removeGroupFromContainer(contentContainer, replaced);
		replaced.anchored = false;
		groupAnchors.delete(replaced);
	}
	state.anchors.set(ordinal, group);
	groupAnchors.set(group, { container: contentContainer, ordinal });
	insertAnchoredGroup(contentContainer, ordinal, group);
	lastChatContainer.invalidate?.();
	capturedTui?.requestRender?.();
}

function restoreAssistantAnchor(parent: any, component: any): void {
	if (!assistantContentContainers.has(parent) || !isVisibleTextMarkdown(component)) return;
	installVisibleAssistantMarkdownRendering(component);
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

function releaseAssistantAnchors(component: any): void {
	if (!(component instanceof AssistantMessageComponent)) return;
	const contentContainer = (component as any).contentContainer;
	if (!(contentContainer instanceof Container)) return;
	const state = assistantContentStates.get(contentContainer);
	if (!state) return;
	for (const group of state.anchors.values()) {
		for (const tool of [...group.children]) delete (tool as any)[PARENT_KEY];
		groupAnchors.delete(group);
		groups.delete(group);
	}
	state.anchors.clear();
	state.finalDivider = undefined;
}

function stripAssistantPhantomPadding(parent: any, component: any): void {
	// Mark the plain Container that an AssistantMessageComponent owns as its
	// content container so we can trim its children later.
	if (parent instanceof AssistantMessageComponent && component instanceof Container && !(component instanceof AssistantMessageComponent)) {
		assistantContentContainers.add(component);
		getAssistantContentState(component);
		installAssistantExpansion(parent, component);
		return;
	}
	if (!assistantContentContainers.has(parent)) return;
	// Drop any Text child whose visible content is empty (only ANSI styling).
	// This is the hidden-thinking label pi renders even when the label is "".
	// Also remove the trailing Spacer run that preceded the label. Otherwise
	// every thinking-only assistant message in a multi-tool loop remains as a
	// one-line blank component; moving the final group into a later text message
	// then exposes all of those accumulated blank lines as a huge gap.
	if (component instanceof Text) {
		const visible = String((component as any).text ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();
		if (visible === "") {
			const index = parent.children.indexOf(component);
			if (index >= 0) parent.children.splice(index, 1);
			while (parent.children.at(-1) instanceof Spacer) parent.children.pop();
		}
	}
}

function installGrouping(): void {
	const host = globalThis as any;
	const prototype = Container.prototype as any;
	const previous = host[PATCH_KEY] as PatchState | undefined;
	// Always (re-)install. On hot-reload (/reload) the old instance's prototype
	// patch stays on Container.prototype but its closures reference the OLD
	// module state (groups/lastActiveGroup). Skipping here would leave the new
	// instance's event handlers reading a different lastActiveGroup than the one
	// the patch writes, so message-boundary sealing would never fire. Re-install
	// with the preserved original so future addChild calls use THIS instance's
	// closures.

	const original = {
		addChild: previous && prototype.addChild === previous.installed.addChild ? previous.original.addChild : prototype.addChild,
		removeChild: previous && prototype.removeChild === previous.installed.removeChild ? previous.original.removeChild : prototype.removeChild,
		clear: previous && prototype.clear === previous.installed.clear ? previous.original.clear : prototype.clear,
	};
	const state: PatchState = {
		active: true,
		prototype,
		original,
		installed: undefined as any,
	};
	state.installed = {
		addChild: function (this: any, component: any) {
			const result = state.original.addChild.call(this, component);
			if (component && typeof component === "object") {
				// Remember where the current assistant message component lives so a
				// thinking-only group can be inserted right after it later.
				if (component instanceof AssistantMessageComponent) {
					lastChatContainer = this;
					lastStreamingComp = component;
					// A run that started before its message component existed can now
					// be placed in the transcript, in front of this message's text.
					if (unattachedThinking.length > 0) ensureThinkingGroup();
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
			if (group instanceof ToolGroupComponent && (group as any)[PARENT_KEY] === this) {
				group.removeTool(component);
				if (group.children.length === 0 && group.entries.length === 0) groups.delete(group);
				return;
			}
			releaseAssistantAnchors(component);
			return state.original.removeChild.call(this, component);
		},
		clear: function (this: any) {
			if (assistantContentContainers.has(this)) {
				// AssistantMessageComponent rebuilds this container for every
				// cumulative stream update. Keep sealed compact groups in the
				// anchor map; restoreAssistantAnchor() reinserts each one before
				// its matching Markdown child as the rebuild proceeds.
				getAssistantContentState(this).nextTextOrdinal = 0;
				return state.original.clear.call(this);
			}
			for (const child of [...(this.children ?? [])]) {
				if (child instanceof ToolGroupComponent) {
					for (const tool of [...child.children] as any[]) delete tool[PARENT_KEY];
					groups.delete(child);
				}
				releaseAssistantAnchors(child);
			}
			return state.original.clear.call(this);
		},
	};
	prototype.addChild = state.installed.addChild;
	prototype.removeChild = state.installed.removeChild;
	prototype.clear = state.installed.clear;
	host[PATCH_KEY] = state;
}

// =============================================================================
// Built-in tool delegation (render nothing natively)
// =============================================================================
// pi's built-in tools carry schema-inferred parameter and result types. compact-ui
// only forwards the calls (rendering is replaced), so they stay opaque here.
type AnyTool = {
	parameters: any;
	execute: (...args: any[]) => Promise<any>;
};

const toolCache = new Map<string, Record<string, AnyTool>>();
function getTools(cwd: string): Record<string, AnyTool> {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = {
			read: createReadTool(cwd),
			bash: createBashTool(cwd),
			edit: createEditTool(cwd),
			write: createWriteTool(cwd),
			find: createFindTool(cwd),
			grep: createGrepTool(cwd),
			ls: createLsTool(cwd),
		};
		toolCache.set(cwd, tools);
	}
	return tools;
}

export default function (pi: ExtensionAPI) {
	installGrouping();
	installNativeThinkingSuppression();
	installCompactionSummaryRendering();

	const delegate = (name: keyof ReturnType<typeof getTools>) =>
		async (
			toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: unknown,
			ctx?: unknown,
		): Promise<any> => {
			return getTools((ctx as { cwd: string }).cwd)[name].execute(toolCallId, params, signal, onUpdate);
		};

	for (const name of ["read", "bash", "edit", "write", "find", "grep", "ls"] as const) {
		pi.registerTool({
			name,
			label: name,
			description: `Built-in ${name} (rendering handled by compact-ui group).`,
			parameters: getTools(process.cwd())[name].parameters,
			execute: delegate(name),
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		currentTheme = ctx.ui.theme;
		ctx.ui.setHiddenThinkingLabel("");
		// Capture the TUI instance via setWidget's factory so the animation can
		// call its throttled requestRender() to repaint just the changed cells.
		ctx.ui.setWidget("compact-anim", (tui: any) => {
			capturedTui = tui;
			return { render: () => [] as string[], invalidate() {} };
		});
		installGrouping();
		installNativeThinkingSuppression();
		installCompactionSummaryRendering();
	});

	pi.on("tool_execution_start", async (event) => {
		toolStarts.set(event.toolCallId, Date.now());
		lastActiveGroup?.invalidate();
	});

	pi.on("tool_execution_end", async (event) => {
		for (const g of groups) {
			for (const t of g.children as any[]) {
				if (t.toolCallId === event.toolCallId) t._groupEndAt = Date.now();
			}
		}
		lastActiveGroup?.invalidate();
	});

	pi.on("message_start", async (event) => {
		const role = (event.message as any)?.role;
		// A new user message is a hard turn boundary: seal whatever block is still
		// open. Assistant/toolResult message boundaries do NOT seal — thinking and
		// tool calls stay in one block until real (non-thinking) text appears.
		if (role === "user" && lastActiveGroup && !lastActiveGroup.sealed) {
			lastActiveGroup.sealed = true;
			finalizeActiveThinking();
			lastActiveGroup.invalidate();
		}
		if (role === "user") {
			for (const g of [...groups]) {
				if (!g.hasVisibleEntries()) {
					if (lastChatContainer) removeGroupFromContainer(lastChatContainer, g);
					groups.delete(g);
				}
			}
			turnStartMs = Date.now();
			activeThinking = null;
			activeThinkingIndex = null;
			activeThinkingBlocks.clear();
			unattachedThinking.length = 0;
			lastSealedThinkingEntry = null;
			lastReportedReasoningTokens = 0;
			handledTextIndexes.clear();
			sealedThinkingIndexes.clear();
			pendingTextSeal = false;
			pendingTextOrdinal = null;
			lastStreamingComp = null;
		} else if (role === "assistant") {
			// contentIndex values are local to one streamed assistant message. Close
			// any run left open by the previous message; a late thinking_end for it is
			// then rejected through sealedThinkingIndexes.
			finalizeActiveThinking();
			handledTextIndexes.clear();
			sealedThinkingIndexes.clear();
			// Reported reasoning usage belongs to one assistant message; a run sealed
			// later must not inherit the previous message's value.
			lastSealedThinkingEntry = null;
			lastReportedReasoningTokens = 0;
			pendingTextSeal = false;
			pendingTextOrdinal = null;
			// Do not insert early thinking beside the previous assistant message.
			// The addChild patch fills this with the current streaming component.
			lastStreamingComp = null;
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
			if (hasIndex && sealedThinkingIndexes.has(contentIndex)) return;
			const startsRun =
				streamType === "thinking_start" || !activeThinking || (hasIndex && activeThinkingIndex !== contentIndex);
			if (startsRun) {
				// Each run is its own entry: close the previous one instead of merging.
				finalizeActiveThinking();
				activeThinkingIndex = hasIndex ? contentIndex : null;
				createThinkingEntry();
			}
			const block = hasIndex ? content[contentIndex] : undefined;
			const blockText =
				block?.type === "thinking"
					? String(block.thinking ?? "")
					: streamType === "thinking_end"
						? String(streamEvent.content ?? "")
						: "";
			if (hasIndex) activeThinkingBlocks.set(contentIndex, blockText);
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
			if (text.length > 0 && !handledTextIndexes.has(contentIndex)) {
				if (activeThinking) updateActiveThinkingTokens(msg);
				handledTextIndexes.add(contentIndex);
				pendingTextSeal = true;
				pendingTextOrdinal =
					content
						.slice(0, Number.isInteger(contentIndex) ? contentIndex + 1 : content.length)
						.filter((item: any) => item?.type === "text" && String(item.text ?? "").trim()).length - 1;
				flushPendingTextSeal();
			}
		} else if (streamType === "done" || streamType === "error") {
			if (activeThinking) updateActiveThinkingTokens(msg);
			finalizeActiveThinking();
			refreshSealedThinkingTokens(msg?.usage?.reasoning);
		}

		// Refresh the active block when thinking starts/stops (event-driven only;
		// no timer, so the transcript scroll position is never yanked around).
		lastActiveGroup?.invalidate();
	});

	pi.on("agent_end", async () => {
		// Turn finished: seal the final block so it stops spinning and shows a
		// stable summary until the user starts the next turn.
		if (lastActiveGroup && !lastActiveGroup.sealed) {
			lastActiveGroup.sealed = true;
			finalizeActiveThinking();
			lastActiveGroup.invalidate();
		}
		for (const g of [...groups]) {
			if (!g.hasVisibleEntries()) {
				if (lastChatContainer) removeGroupFromContainer(lastChatContainer, g);
				groups.delete(g);
			}
		}
		refreshSealedThinkingTokens();
		// Separate the final visible text from the preceding work with a divider
		// that reports how long this turn ran.
		const elapsedMs = Date.now() - turnStartMs;
		insertTurnDivider(elapsedMs);
		activeThinking = null;
		activeThinkingIndex = null;
		activeThinkingBlocks.clear();
		unattachedThinking.length = 0;
		lastSealedThinkingEntry = null;
		lastReportedReasoningTokens = 0;
		handledTextIndexes.clear();
		sealedThinkingIndexes.clear();
		pendingTextSeal = false;
		pendingTextOrdinal = null;
	});

	pi.registerCommand("compact-ui-config", {
		description: "Interactive compact-ui settings (arrows to select, Enter to adjust, Esc to close)",
		handler: async (_args, ctx) => {
			// Non-TUI modes (print/json) can't show the interactive menu.
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`compact: expandedToolLines=${config.expandedToolLines}, expandedThinkingLines=${config.expandedThinkingLines}`,
					"info",
				);
				return;
			}

			const changed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
				let anyChanged = false;
				const items: SettingItem[] = CONFIG_KEYS.map((meta) => ({
					id: meta.id,
					label: meta.label,
					currentValue: String((config as any)[meta.id]),
					description: meta.description,
					submenu: (currentValue: string, subDone: (value?: string) => void) =>
						makeStepper(meta.label, Number(currentValue), meta, theme, subDone),
				}));
			const settingsList = new SettingsList(
				items,
				Math.min(items.length, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					// Persist and refresh the live groups when SettingsList commits a change.
					(config as any)[id] = Number(newValue);
					saveConfig();
					anyChanged = true;
					for (const g of groups) g.invalidate();
				},
				() => done(anyChanged),
			);
			return {
				render(width: number) {
					return settingsList.render(width);
				},
				invalidate() {
					settingsList.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});

		if (changed) {
			ctx.ui.notify("compact-ui settings saved", "info");
		}
	},
});
}
