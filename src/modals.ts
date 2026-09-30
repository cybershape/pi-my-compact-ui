/** 工具与思考详情弹窗、交互式条目选择器。 */
import { matchesKey, Key, wrapTextWithAnsi, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { GroupEntry } from "./types.js";
import { toolStatus, thinkingTokenLabel, toolResultText, toolSummary } from "./helpers.js";
import { THINKING_SPINNER, SPINNER_MS, SPINNER, spinnerStart } from "./constants.js";
import { runtime } from "./state.js";
import { thinkingSpinnerFrame } from "./animation.js";
import { toolElapsed } from "./streaming-tools.js";

export class DetailModalComponent implements Component {
	readonly entry: GroupEntry;
	private scrollTop = 0;
	private followingEnd = true;
	private lastContentLineCount = 0;
	private lastInnerHeight = 10;
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(entry: GroupEntry) {
		this.entry = entry;
		this.startPollingIfNeeded();
	}

	private isEntryActive(): boolean {
		if (this.entry.kind === "thinking") {
			return this.entry.active;
		}
		return toolStatus(this.entry.tool) === "pending";
	}

	private startPollingIfNeeded(): void {
		if (this.isEntryActive()) {
			const interval = this.entry.kind === "thinking" ? THINKING_SPINNER.intervalMs : SPINNER_MS;
			this.pollTimer = setInterval(() => {
				runtime.capturedTui?.requestRender?.();
				if (!this.isEntryActive() && this.pollTimer) {
					clearInterval(this.pollTimer);
					this.pollTimer = null;
				}
			}, interval);
		}
	}

	dispose(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	invalidate(): void {}

	scrollBy(delta: number): void {
		this.scrollTo(this.scrollTop + delta);
	}

	scrollTo(newTop: number): void {
		const maxScroll = Math.max(0, this.lastContentLineCount - this.lastInnerHeight);
		this.scrollTop = Math.max(0, Math.min(maxScroll, newTop));
		if (this.scrollTop >= maxScroll) {
			this.followingEnd = true;
		} else {
			this.followingEnd = false;
		}
		runtime.capturedTui?.requestRender?.();
	}

	scrollToEnd(): void {
		this.followingEnd = true;
		this.scrollTop = Math.max(0, this.lastContentLineCount - this.lastInnerHeight);
		runtime.capturedTui?.requestRender?.();
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			closeDetailModal();
			return true;
		}
		if (matchesKey(data, Key.up) || data === "k" || data === "K") {
			this.scrollBy(-1);
			return true;
		}
		if (matchesKey(data, Key.down) || data === "j" || data === "J") {
			this.scrollBy(1);
			return true;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.left)) {
			this.scrollBy(-10);
			return true;
		}
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.right) || matchesKey(data, Key.space)) {
			this.scrollBy(10);
			return true;
		}
		if (matchesKey(data, Key.home)) {
			this.scrollTo(0);
			return true;
		}
		if (matchesKey(data, Key.end)) {
			this.scrollToEnd();
			return true;
		}
		return false;
	}

	render(width: number): string[] {
		const theme = runtime.currentTheme;
		const fg = (color: string, t: string) => theme?.fg?.(color, t) ?? t;
		const bold = theme?.bold ? theme.bold : (t: string) => t;
		const borderFg = (t: string) => fg("borderAccent", fg("border", t));
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;

		const termHeight = runtime.capturedTui?.terminal?.rows ?? 24;
		const innerHeight = Math.max(5, Math.min(24, Math.floor(termHeight * 0.8) - 2));
		const innerWidth = Math.max(10, width - 4);

		let title = "";
		const contentLines: string[] = [];

		if (this.entry.kind === "thinking") {
			const spin = this.entry.active ? thinkingSpinnerFrame() : undefined;
			const icon = spin?.frame ?? "✓";
			const tokenStr = thinkingTokenLabel(this.entry);
			title = `${fg(spin?.color ?? "thinkingText", icon)} ${fg("toolTitle", "Thinking")} ${fg("muted", tokenStr)}`;

			const rawText = this.entry.text.trim();
			if (!rawText) {
				contentLines.push(fg("dim", "(thinking...)"));
			} else {
				for (const rawLine of rawText.split("\n")) {
					const wrapped = wrapTextWithAnsi(rawLine, innerWidth);
					if (wrapped.length === 0) {
						contentLines.push("");
					} else {
						for (const wl of wrapped) {
							contentLines.push(fg("thinkingText", wl));
						}
					}
				}
			}
		} else {
			const tool = this.entry.tool;
			const st = toolStatus(tool);
			const icon = st === "pending" ? frame : st === "error" ? "✗" : "✓";
			const color = st === "pending" ? "accent" : st === "error" ? "error" : "success";
			const elapsed = `(${toolElapsed(tool)}s)`;
			title = `${fg(color, icon)} ${fg("toolTitle", bold(tool.toolName))} ${fg("muted", elapsed)}`;

			if (tool.toolName === "bash" || tool.toolName === "powershell") {
				const cmd = tool.args?.command || "…";
				for (const wl of wrapTextWithAnsi(`$ ${cmd}`, innerWidth)) {
					contentLines.push(fg("accent", wl));
				}
			} else if (tool.args?.path) {
				contentLines.push(`${fg("dim", "Path:")} ${tool.args.path}`);
			} else if (tool.args) {
				try {
					const jsonStr = JSON.stringify(tool.args, null, 2);
					for (const l of jsonStr.split("\n")) {
						for (const wl of wrapTextWithAnsi(l, innerWidth)) {
							contentLines.push(fg("dim", wl));
						}
					}
				} catch {
					contentLines.push(fg("dim", String(tool.args)));
				}
			}

			const resultText = toolResultText(tool);
			contentLines.push("");
			contentLines.push(fg("dim", "── Output ──"));

			if (resultText) {
				for (const rawLine of resultText.split("\n")) {
					const wrapped = wrapTextWithAnsi(rawLine, innerWidth);
					if (wrapped.length === 0) {
						contentLines.push("");
					} else {
						for (const wl of wrapped) {
							contentLines.push(fg("toolOutput", wl));
						}
					}
				}
			} else {
				contentLines.push(fg("dim", st === "pending" ? "(running, waiting for output...)" : "(no output)"));
			}
		}

		const totalLines = contentLines.length;
		this.lastContentLineCount = totalLines;
		this.lastInnerHeight = innerHeight;
		const maxScroll = Math.max(0, totalLines - innerHeight);

		if (this.followingEnd) {
			this.scrollTop = maxScroll;
		} else {
			this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop));
		}

		// Top border with close button hint
		const closeHint = "[Esc to close]";
		const visClose = visibleWidth(closeHint);
		const maxTitleWidth = Math.max(10, width - visClose - 12);
		const clampedTitle = truncateToWidth(title, maxTitleWidth, "…");
		const visTitle = visibleWidth(clampedTitle);
		const fillerLen = Math.max(1, width - visTitle - visClose - 8);
		const topBorder =
			borderFg("┌─ ") +
			clampedTitle +
			borderFg(" " + "─".repeat(fillerLen) + " ") +
			fg("muted", closeHint) +
			borderFg(" ─┐");

		const result: string[] = [truncateToWidth(topBorder, width)];

		// Middle content lines
		const slice = contentLines.slice(this.scrollTop, this.scrollTop + innerHeight);
		while (slice.length < innerHeight) {
			slice.push("");
		}

		const showScrollbar = totalLines > innerHeight;
		const thumbY = showScrollbar && maxScroll > 0 ? Math.round((this.scrollTop / maxScroll) * (innerHeight - 1)) : -1;

		for (let i = 0; i < innerHeight; i++) {
			const line = slice[i] ?? "";
			const vis = visibleWidth(line);
			const truncated = vis > innerWidth ? truncateToWidth(line, innerWidth, "…") : line;
			const truncVis = visibleWidth(truncated);
			const pad = Math.max(0, innerWidth - truncVis);
			const rightChar = showScrollbar && i === thumbY ? fg("scrollbarThumb", "█") : borderFg("│");
			result.push(borderFg("│ ") + truncated + " ".repeat(pad) + " " + rightChar);
		}

		// Bottom border
		const scrollInfo =
			totalLines > innerHeight
				? ` [${this.scrollTop + 1}-${Math.min(totalLines, this.scrollTop + innerHeight)}/${totalLines}] `
				: "";
		const visInfo = visibleWidth(scrollInfo);
		const botFiller = Math.max(1, width - 2 - visInfo);
		const botBorder =
			borderFg("└" + "─".repeat(botFiller)) + (scrollInfo ? fg("dim", scrollInfo) : "") + borderFg("┘");
		result.push(truncateToWidth(botBorder, width));

		return result;
	}
}

export function openDetailModal(entry: GroupEntry): void {
	closeDetailModal();

	const modal = new DetailModalComponent(entry);
	runtime.activeModalComponent = modal;

	if (runtime.capturedTui) {
		runtime.activeModalHandle = runtime.capturedTui.showOverlay(modal, {
			anchor: "center",
			width: "85%",
			maxHeight: "80%",
		});
		runtime.capturedTui.requestRender();
		return;
	}

	if (runtime.activeUIContext?.custom) {
		runtime.activeUIContext.custom(
			(tui: any, _theme: any, _keybindings: any, done: () => void) => {
				runtime.capturedTui = tui;
				runtime.activeModalCloseFn = done;
				return modal;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "85%", maxHeight: "80%" },
				onHandle: (handle: any) => {
					runtime.activeModalHandle = handle;
				},
			},
		);
	}
}

export function closeDetailModal(): void {
	if (runtime.activeModalComponent) {
		runtime.activeModalComponent.dispose();
		runtime.activeModalComponent = null;
	}
	if (runtime.activeModalHandle) {
		const handle = runtime.activeModalHandle;
		runtime.activeModalHandle = null;
		handle.hide();
	}
	if (runtime.activeModalCloseFn) {
		const done = runtime.activeModalCloseFn;
		runtime.activeModalCloseFn = null;
		done();
	}
	runtime.capturedTui?.requestRender?.();
}

export function getAllInspectableEntries(): GroupEntry[] {
	const results: GroupEntry[] = [];
	for (const g of runtime.groups) {
		for (const entry of g.getVisibleEntries()) {
			results.push(entry);
		}
	}
	return results;
}

export class InspectSelectorModal implements Component {
	private entries: GroupEntry[] = [];
	private selectedIndex = 0;
	private scrollTop = 0;
	private visibleHeight = 10;

	constructor() {
		this.refreshEntries(true);
	}

	refreshEntries(isInitial = false): void {
		const wasAtEnd = isInitial || this.selectedIndex >= this.entries.length - 1;
		this.entries = getAllInspectableEntries();
		if (this.entries.length === 0) {
			this.selectedIndex = 0;
			this.scrollTop = 0;
			return;
		}
		if (wasAtEnd) {
			// Place newest entries at the bottom; focus starts on the latest (last) entry
			this.selectedIndex = this.entries.length - 1;
		} else {
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.entries.length - 1));
		}
		this.adjustScroll();
	}

	private adjustScroll(): void {
		if (this.entries.length === 0) {
			this.scrollTop = 0;
			return;
		}
		if (this.selectedIndex < this.scrollTop) {
			this.scrollTop = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollTop + this.visibleHeight) {
			this.scrollTop = this.selectedIndex - this.visibleHeight + 1;
		}
		const maxScroll = Math.max(0, this.entries.length - this.visibleHeight);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			closeInspectSelectorModal();
			return true;
		}
		if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
			const selected = this.entries[this.selectedIndex];
			if (selected) {
				closeInspectSelectorModal();
				openDetailModal(selected);
			}
			return true;
		}
		if (matchesKey(data, Key.up) || data === "k" || data === "K") {
			if (this.entries.length > 0) {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				this.adjustScroll();
				runtime.capturedTui?.requestRender?.();
			}
			return true;
		}
		if (matchesKey(data, Key.down) || data === "j" || data === "J") {
			if (this.entries.length > 0) {
				this.selectedIndex = Math.min(this.entries.length - 1, this.selectedIndex + 1);
				this.adjustScroll();
				runtime.capturedTui?.requestRender?.();
			}
			return true;
		}
		if (matchesKey(data, Key.pageUp)) {
			if (this.entries.length > 0) {
				this.selectedIndex = Math.max(0, this.selectedIndex - this.visibleHeight);
				this.adjustScroll();
				runtime.capturedTui?.requestRender?.();
			}
			return true;
		}
		if (matchesKey(data, Key.pageDown)) {
			if (this.entries.length > 0) {
				this.selectedIndex = Math.min(this.entries.length - 1, this.selectedIndex + this.visibleHeight);
				this.adjustScroll();
				runtime.capturedTui?.requestRender?.();
			}
			return true;
		}
		if (matchesKey(data, Key.home)) {
			if (this.entries.length > 0) {
				this.selectedIndex = 0;
				this.adjustScroll();
				runtime.capturedTui?.requestRender?.();
			}
			return true;
		}
		if (matchesKey(data, Key.end)) {
			if (this.entries.length > 0) {
				this.selectedIndex = this.entries.length - 1;
				this.adjustScroll();
				runtime.capturedTui?.requestRender?.();
			}
			return true;
		}
		return false;
	}

	render(width: number): string[] {
		const theme = runtime.currentTheme;
		const fg = (color: string, t: string) => theme?.fg?.(color, t) ?? t;
		const bold = theme?.bold ? theme.bold : (t: string) => t;
		const borderFg = (t: string) => fg("borderAccent", fg("border", t));
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;

		const termHeight = runtime.capturedTui?.terminal?.rows ?? 24;
		const innerHeight = Math.max(5, Math.min(16, Math.floor(termHeight * 0.65)));
		this.visibleHeight = innerHeight;
		this.adjustScroll();

		const innerWidth = Math.max(10, width - 4);
		const lines: string[] = [];

		const title = ` ${fg("accent", bold("Inspect"))} ${fg("dim", "(↑/↓ select · Enter view · Esc exit)")} `;
		const visTitle = visibleWidth(title);
		const topFiller = Math.max(1, width - 2 - visTitle);
		const topBorder = borderFg("┌" + "─".repeat(topFiller)) + title + borderFg("┐");
		lines.push(truncateToWidth(topBorder, width));

		if (this.entries.length === 0) {
			const emptyMsg = "  (no tool calls or thinking entries)";
			for (let i = 0; i < innerHeight; i++) {
				const row = i === Math.floor(innerHeight / 2) ? fg("dim", emptyMsg) : "";
				const pad = Math.max(0, innerWidth - visibleWidth(row));
				lines.push(borderFg("│ ") + row + " ".repeat(pad) + borderFg(" │"));
			}
		} else {
			for (let i = 0; i < innerHeight; i++) {
				const entryIdx = this.scrollTop + i;
				const entry = this.entries[entryIdx];
				if (!entry) {
					lines.push(borderFg("│ ") + " ".repeat(innerWidth) + borderFg(" │"));
					continue;
				}

				const isSelected = entryIdx === this.selectedIndex;
				const prefix = isSelected ? fg("accent", bold("▶ ")) : "  ";

				let leftContent = "";
				let rightStr = "";

				if (entry.kind === "tool") {
					const tool = entry.tool;
					const st = toolStatus(tool);
					const icon = st === "pending" ? frame : st === "error" ? "✗" : "✓";
					const iconColor = st === "pending" ? "accent" : st === "error" ? "error" : "success";
					const s = toolSummary(tool.toolName, tool.args);
					const elapsed = `(${toolElapsed(tool)}s)`;
					const toolLabel = fg("toolTitle", bold(s.name));
					const contentText = fg("dim", s.content || "…");
					leftContent = `${prefix}${fg(iconColor, icon)} ${toolLabel} ${contentText}`;
					rightStr = fg("muted", elapsed);
				} else {
					const spin = entry.active ? thinkingSpinnerFrame() : undefined;
					const icon = spin?.frame ?? "✓";
					const tokenLabel = thinkingTokenLabel(entry);
					const tText = entry.text.trim().replace(/[*_#`>]+/g, "").replace(/\s+/g, " ");
					const thinkingLabel = fg("toolTitle", "thinking");
					const contentText = fg("thinkingText", tText || "(thinking...)");
					leftContent = `${prefix}${fg(spin?.color ?? "thinkingText", icon)} ${thinkingLabel} ${contentText}`;
					rightStr = fg("muted", tokenLabel);
				}

				const maxLeft = Math.max(1, innerWidth - visibleWidth(rightStr) - 1);
				const leftTrunc = truncateToWidth(leftContent, maxLeft, "…");
				const gap = Math.max(1, innerWidth - visibleWidth(leftTrunc) - visibleWidth(rightStr));
				let rowLine = `${leftTrunc}${" ".repeat(gap)}${rightStr}`;

				const rowVis = visibleWidth(rowLine);
				if (rowVis < innerWidth) {
					rowLine += " ".repeat(innerWidth - rowVis);
				} else if (rowVis > innerWidth) {
					rowLine = truncateToWidth(rowLine, innerWidth);
				}

				if (isSelected) {
					if (theme?.bg) {
						rowLine = theme.bg("selectedBg", rowLine);
					} else if (theme?.inverse) {
						rowLine = theme.inverse(rowLine);
					}
				}

				lines.push(borderFg("│ ") + rowLine + borderFg(" │"));
			}
		}

		const countInfo =
			this.entries.length > 0
				? ` [${this.selectedIndex + 1}/${this.entries.length}] `
				: "";
		const visCount = visibleWidth(countInfo);
		const botFiller = Math.max(1, width - 2 - visCount);
		const botBorder =
			borderFg("└" + "─".repeat(botFiller)) + (countInfo ? fg("dim", countInfo) : "") + borderFg("┘");
		lines.push(truncateToWidth(botBorder, width));

		return lines;
	}

	dispose(): void {}
	invalidate(): void {}
}

export function openInspectSelectorModal(): void {
	if (runtime.activeModalHandle) {
		closeDetailModal();
	}
	closeInspectSelectorModal();

	const modal = new InspectSelectorModal();
	runtime.activeSelectorComponent = modal;

	if (runtime.capturedTui) {
		runtime.activeSelectorHandle = runtime.capturedTui.showOverlay(modal, {
			anchor: "center",
			width: "85%",
			maxHeight: "70%",
		});
		runtime.capturedTui.requestRender();
		return;
	}

	if (runtime.activeUIContext?.custom) {
		runtime.activeUIContext.custom(
			(tui: any, _theme: any, _keybindings: any, done: () => void) => {
				runtime.capturedTui = tui;
				runtime.activeSelectorCloseFn = done;
				return modal;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "85%", maxHeight: "70%" },
				onHandle: (handle: any) => {
					runtime.activeSelectorHandle = handle;
				},
			},
		);
	}
}

export function closeInspectSelectorModal(): void {
	if (runtime.activeSelectorHandle) {
		const handle = runtime.activeSelectorHandle;
		runtime.activeSelectorHandle = null;
		handle.hide();
	}
	if (runtime.activeSelectorCloseFn) {
		const done = runtime.activeSelectorCloseFn;
		runtime.activeSelectorCloseFn = null;
		done();
	}
	if (runtime.activeSelectorComponent) {
		runtime.activeSelectorComponent = null;
	}
	runtime.capturedTui?.requestRender?.();
}
