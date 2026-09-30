/** 将内部代码围栏标记转换为保留 ANSI 高亮的背景面板。 */
import { truncateToWidth, visibleWidth, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MarkdownTheme, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { CODE_BLOCK_PADDING_X, MARKDOWN_RENDER_PATCH_KEY } from "./constants.js";
import { runtime } from "./state.js";

export function isCompactCodeBlockOpen(visible: string): boolean {
	return visible === "┌─" || visible.startsWith("┌─ ");
}

export function isCompactCodeBlockClose(visible: string): boolean {
	return visible === "└─";
}

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

export function renderCodeBlockBackgroundRow(content: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const horizontalPadding = Math.min(CODE_BLOCK_PADDING_X, Math.floor((safeWidth - 1) / 2));
	const innerWidth = Math.max(1, safeWidth - horizontalPadding * 2);
	const clipped = truncateToWidth(content, innerWidth, "…");
	const rightFill = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const row = `${" ".repeat(horizontalPadding)}${clipped}${rightFill}${" ".repeat(horizontalPadding)}`;
	return runtime.currentTheme?.bg?.("toolPendingBg", row) ?? row;
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
				const label = runtime.currentTheme?.fg?.("muted", language) ?? language;
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

export function installVisibleAssistantMarkdownRendering(component: Markdown): void {
	const markdown = component as any;
	if (markdown[MARKDOWN_RENDER_PATCH_KEY]) return;
	markdown.theme = getCompactMarkdownTheme();
	const originalRender = markdown.render.bind(markdown);
	markdown.render = (width: number): string[] =>
		normalizeCompactCodeBlockLines(originalRender(width), width, Number(markdown.paddingX) || 0);
	markdown[MARKDOWN_RENDER_PATCH_KEY] = { originalRender };
	markdown.invalidate();
}
