import assert from "node:assert/strict";
import { test } from "node:test";
import { CompactionSummaryMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { CompactionHeaderComponent, installCompactionSummaryRendering } from "../src/compaction.js";
import { TurnDividerComponent } from "../src/assistant-patches.js";

initTheme("dark", false);

test("压缩摘要标题按宽度退化为短标题，不溢出", () => {
	const header = new CompactionHeaderComponent(12345);
	assert.ok(header.render(80)[0]!.includes("Context compacted"));
	for (const width of [1, 10, 30]) assert.ok(header.render(width).every((line) => visibleWidth(line) <= width));
	assert.ok(header.render(30)[0]!.includes("Compacted"));
});

test("压缩摘要补丁热重载后保持单行，展开不显示原始 summary", () => {
	installCompactionSummaryRendering();
	installCompactionSummaryRendering();
	const component = new CompactionSummaryMessageComponent({
		role: "compactionSummary", summary: "full summary text", tokensBefore: 1234, timestamp: Date.now(),
	} as any);
	const before = component.render(80).map(stripTerminalSequences);
	component.setExpanded(true);
	const after = component.render(80).map(stripTerminalSequences);
	assert.deepEqual(after, before);
	assert.ok(after.join("\n").includes("Context compacted"));
	assert.ok(!after.join("\n").includes("full summary text"));
});

test("回合耗时分隔线显示耗时且保持窄终端宽度", () => {
	const divider = new TurnDividerComponent("1m 2s");
	assert.ok(divider.render(60)[0]!.includes("worked for 1m 2s"));
	for (const width of [1, 5, 20]) assert.ok(divider.render(width).every((line) => visibleWidth(line) <= width));
});
