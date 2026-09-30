/** 压缩摘要的紧凑呈现与可热重载的原型补丁。 */
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { runtime } from "./state.js";
import { formatTokenK } from "./helpers.js";
import { CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent";
import { COMPACTION_STYLE_PATCH_KEY, GROUP_PADDING_X } from "./constants.js";

export class CompactionHeaderComponent implements Component {
	constructor(private readonly tokensBefore: number) {}

	render(width: number): string[] {
		const theme = runtime.currentTheme;
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

export function installCompactionSummaryRendering(): void {
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
