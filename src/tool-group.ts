/** 按照原始条目顺序渲染折叠分组与有界 Markdown 预览。 */
import { Container, Markdown, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { DefaultTextStyle } from "@earendil-works/pi-tui";
import type { GroupEntry, MarkdownPreview, ThinkingEntry } from "./types.js";
import { absorbPreparingTool, rememberToolStart, toolElapsed } from "./streaming-tools.js";
import { hideGroupedToolRender } from "./guards.js";
import { PARENT_KEY, SPINNER, spinnerStart, SPINNER_MS, GROUP_PADDING_X, GROUP_PADDING_RIGHT } from "./constants.js";
import { toolStatus, toolSummary, thinkingTokenLabel, toolResultText } from "./helpers.js";
import { getCompactMarkdownTheme, normalizeCompactCodeBlockLines } from "./markdown.js";
import { runtime } from "./state.js";
import { thinkingSpinnerFrame, scheduleAnimation } from "./animation.js";
import { config } from "./config.js";

export class ToolGroupComponent extends Container {
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
		absorbPreparingTool(tool);
		hideGroupedToolRender(tool);
		rememberToolStart(String(tool?.toolCallId ?? ""));
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
	// Tool name in bold accent, tool payload in dim, elapsed right-aligned to width.
	private toolRow(rail: string, tool: any, frame: string, width: number, isDim = false): string {
		const theme = runtime.currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const bold = theme?.bold ? theme.bold : (t: string) => t;
		const st = toolStatus(tool);
		const s = toolSummary(tool.toolName, tool.args);
		const prefix = rail ? fg("dim", rail) : "";
		const leftHeader = isDim
			? `${prefix}${fg("dim", this.iconFor(tool, frame))} ${fg("dim", s.name)}`
			: `${prefix}${fg(this.colorFor(st), this.iconFor(tool, frame))} ${fg("toolTitle", bold(s.name))}`;
		const right = fg(isDim ? "dim" : "muted", `(${toolElapsed(tool)}s)`);
		const rightLen = visibleWidth(right);
		const headerLen = visibleWidth(leftHeader);

		if (s.content) {
			const maxContentLen = width - headerLen - 1 - rightLen - 1;
			if (maxContentLen > 3) {
				const truncatedContent = truncateToWidth(s.content, maxContentLen, "…");
				const left = `${leftHeader} ${fg("dim", truncatedContent)}`;
				const gap = Math.max(1, width - visibleWidth(left) - rightLen);
				return `${left}${" ".repeat(gap)}${right}`;
			}
		}

		const gap = Math.max(1, width - headerLen - rightLen);
		return `${leftHeader}${" ".repeat(gap)}${right}`;
	}

	// One row per thinking run. The spinner marks the run that is still streaming;
	// the completion mark is written as soon as the run ends. Token label is right-aligned.
	private thinkingRow(
		rail: string,
		entry: ThinkingEntry,
		width: number,
		showPreview = true,
		isDim = false,
	): string {
		const theme = runtime.currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const spin = entry.active ? thinkingSpinnerFrame() : undefined;
		const icon = spin?.frame ?? "✓";
		const iconColor = isDim ? "dim" : (spin?.color ?? "thinkingText");
		const prefix = rail ? fg("dim", rail) : "";
		const preview = showPreview ? entry.text.trim().replace(/[*_#`>]+/g, "") : "";

		if (showPreview && !preview) {
			const label = entry.active ? "thinking..." : "thinking";
			const titleColor = isDim ? "dim" : "toolTitle";
			return `${prefix}${fg(iconColor, icon)} ${fg(titleColor, label)}`;
		}

		const titleColor = isDim ? "dim" : "toolTitle";
		const leftHeader = `${prefix}${fg(iconColor, icon)} ${fg(titleColor, "thinking")}`;

		const tokenLabel = thinkingTokenLabel(entry);
		const right = fg(isDim ? "dim" : "muted", tokenLabel);
		const rightLen = visibleWidth(right);
		const headerLen = visibleWidth(leftHeader);

		if (preview) {
			const maxPreviewLen = width - headerLen - 1 - rightLen - 1;
			if (maxPreviewLen > 3) {
				const truncated = truncateToWidth(preview.replace(/\s+/g, " "), maxPreviewLen, "... ");
				const contentColor = isDim ? "dim" : "thinkingText";
				const left = `${leftHeader} ${fg(contentColor, truncated)}`;
				const gap = Math.max(1, width - visibleWidth(left) - rightLen);
				return `${left}${" ".repeat(gap)}${right}`;
			}
		}

		const gap = Math.max(1, width - headerLen - rightLen);
		return `${leftHeader}${" ".repeat(gap)}${right}`;
	}

	// Folded: header + one line per entry, in stream order (oldest first).
	// When there is only 1 visible entry, do not show hierarchy (no header, no tree rail).
	private renderCollapsed(width: number, visible: GroupEntry[]): string[] {
		const theme = runtime.currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;

		if (visible.length === 1) {
			const entry = visible[0]!;
			if (entry.kind === "tool") {
				return [this.toolRow("", entry.tool, frame, width)];
			}
			return [this.thinkingRow("", entry, width)];
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
		const thinkingSpin = !hasPendingTool && working ? thinkingSpinnerFrame() : undefined;
		// Left icon: spinner while working, completion mark once the group is done.
		const leftIcon = working ? (thinkingSpin?.frame ?? frame) : "✓";
		const leftColor = thinkingSpin?.color ?? stateColor;

		const maxEntries = config.maxGroupEntries ?? 5;
		const hiddenCount = visible.length > maxEntries ? visible.length - maxEntries : 0;
		const hiddenSuffix = hiddenCount > 0 ? ` ${fg("muted", `(${hiddenCount} hidden)`)}` : "";
		lines.push(`${fg(leftColor, leftIcon)} ${fg(stateColor, state)}${hiddenSuffix}`);

		// Every entry is shown, one line each, in the order the model produced it.
		// When hiddenCount > 0, hide oldest entries and fade the top visible entry.
		const entriesToRender = hiddenCount > 0 ? visible.slice(hiddenCount) : visible;
		const total = entriesToRender.length;
		for (let index = 0; index < total; index++) {
			const entry = entriesToRender[index]!;
			const rail = index === total - 1 ? "└  " : "│  ";
			const isDim = hiddenCount > 0 && index === 0;
			lines.push(
				entry.kind === "thinking"
					? this.thinkingRow(rail, entry, width, true, isDim)
					: this.toolRow(rail, entry.tool, frame, width, isDim),
			);
		}

		return lines;
	}

	// Expanded: per-tool detail + every thinking run, in stream order.
	// When there is only 1 visible entry, do not show hierarchy (no header, no tree rail).
	private renderExpanded(width: number, visible: GroupEntry[]): string[] {
		const theme = runtime.currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;
		const lines: string[] = [];

		if (visible.length === 1) {
			const entry = visible[0]!;
			const sub = "  ";
			if (entry.kind === "tool") {
				const tool = entry.tool;
				lines.push(this.toolRow("", tool, frame, width));
				const result = toolResultText(tool);
				if (result) {
					const markdownWidth = Math.max(1, width - sub.length);
					const preview = this.renderMarkdownPreview(
						`tool:${tool.toolCallId ?? 0}`,
						result,
						markdownWidth,
						config.expandedToolLines,
						{ color: (text) => runtime.currentTheme?.fg?.("toolOutput", text) ?? text },
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

			lines.push(this.thinkingRow("", entry, width, false));
			const tText = entry.text.trim();
			if (tText) {
				const markdownWidth = Math.max(1, width - sub.length);
				const preview = this.renderMarkdownPreview(
					`thinking:${entry.id}`,
					tText,
					markdownWidth,
					config.expandedThinkingLines,
					{ color: (text) => runtime.currentTheme?.fg?.("thinkingText", text) ?? text, italic: true },
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
		const thinkingSpin = !hasPendingTool && working ? thinkingSpinnerFrame() : undefined;
		// Left icon: spinner while working, completion mark once the group is done.
		const leftIcon = working ? (thinkingSpin?.frame ?? frame) : "✓";
		const leftColor = thinkingSpin?.color ?? stateColor;
		lines.push(`${fg(leftColor, leftIcon)} ${fg(stateColor, state)}`);

		const total = visible.length;
		for (let index = 0; index < total; index++) {
			const entry = visible[index]!;
			const isLast = index === total - 1;
			const rail = isLast ? "└─ " : "├─ ";
			const sub = isLast ? "    " : "│   ";
			if (entry.kind === "tool") {
				const tool = entry.tool;
				lines.push(this.toolRow(rail, tool, frame, width));
				const result = toolResultText(tool);
				if (result) {
					const markdownWidth = Math.max(1, width - sub.length);
					const preview = this.renderMarkdownPreview(
						`tool:${tool.toolCallId ?? index}`,
						result,
						markdownWidth,
						config.expandedToolLines,
						{ color: (text) => runtime.currentTheme?.fg?.("toolOutput", text) ?? text },
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

			lines.push(this.thinkingRow(rail, entry, width, false));
			const tText = entry.text.trim();
			if (tText) {
				const markdownWidth = Math.max(1, width - sub.length);
				const preview = this.renderMarkdownPreview(
					`thinking:${entry.id}`,
					tText,
					markdownWidth,
					config.expandedThinkingLines,
					{ color: (text) => runtime.currentTheme?.fg?.("thinkingText", text) ?? text, italic: true },
				);
				for (const row of preview.lines) {
					lines.push(`${fg("dim", sub)}${row}`);
				}
				if (preview.truncated) {
					lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
				}
			}
		}

		return lines;
	}





	override render(width: number): string[] {
		const visible = this.getVisibleEntries();
		if (visible.length === 0) return [];

		if (this.needsAnimation()) scheduleAnimation();

		const padding = " ".repeat(Math.min(GROUP_PADDING_X, Math.max(0, width - 1)));
		const contentWidth = Math.max(1, width - padding.length - GROUP_PADDING_RIGHT);
		const lines = this._expanded
			? this.renderExpanded(contentWidth, visible)
			: this.renderCollapsed(contentWidth, visible);
		if (lines.length === 0) return [];
		const rendered = lines.map((line) => padding + truncateToWidth(line, contentWidth, "…"));
		// Native ToolExecutionComponent starts with Spacer(1). Our custom render
		// bypasses that child tree, so restore the same single leading gap while
		// the group is top-level. Anchored groups receive deterministic spacing
		// from placeAnchoredGroupBeforeText() instead.
		return this.anchored ? rendered : ["", ...rendered];
	}
}
