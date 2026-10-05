import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.js";
import { makeStepper } from "../src/settings.js";

test("configuration loads the collapsed entry limit without changing defaults", () => {
	const loaded = loadConfig("unused", (path, encoding) => {
		assert.equal(path, "unused");
		assert.equal(encoding, "utf-8");
		return '{"maxGroupEntries":12}';
	});
	assert.deepEqual(loaded, { maxGroupEntries: 12 });
	assert.deepEqual(DEFAULT_CONFIG, { maxGroupEntries: 5 });
});

test("obsolete expansion settings are ignored when reading legacy configuration", () => {
	assert.deepEqual(loadConfig("unused", () => '{"expandedToolLines":12,"expandedThinkingLines":20,"maxGroupEntries":7}'), { maxGroupEntries: 7 });
	assert.deepEqual(loadConfig("unused", () => '{"expandedToolLines":12}'), DEFAULT_CONFIG);
});

test("缺失或损坏的配置返回独立的默认值副本", () => {
	const missing = loadConfig("unused", () => { throw new Error("ENOENT"); });
	const invalid = loadConfig("unused", () => "not json");
	assert.deepEqual(missing, DEFAULT_CONFIG);
	assert.deepEqual(invalid, DEFAULT_CONFIG);
	assert.notEqual(missing, invalid);
	missing.maxGroupEntries = 9;
	assert.equal(DEFAULT_CONFIG.maxGroupEntries, 5);
});

test("配置保存采用可注入的写入器，不触碰真实配置文件", () => {
	let saved = "";
	saveConfig(DEFAULT_CONFIG, "unused", (path, data) => {
		assert.equal(path, "unused");
		saved = data;
	});
	assert.deepEqual(JSON.parse(saved), DEFAULT_CONFIG);
	assert.ok(saved.endsWith("\n"));
	assert.doesNotThrow(() => saveConfig(DEFAULT_CONFIG, "unused", () => { throw new Error("read-only"); }));
});

test("数值编辑器限制上下界，Enter 保存，Esc 取消", () => {
	let result: string | undefined = "not called";
	const stepper = makeStepper("Lines", 2, { min: 1, max: 3, step: 1 }, null, (value) => { result = value; });
	stepper.handleInput?.("-");
	stepper.handleInput?.("-");
	stepper.handleInput?.("\r");
	assert.equal(result, "1");
	stepper.handleInput?.("+");
	stepper.handleInput?.("+");
	stepper.handleInput?.("+");
	stepper.handleInput?.("\r");
	assert.equal(result, "3");
	stepper.handleInput?.("\x1b");
	assert.equal(result, undefined);
});

test("数值编辑器缓存渲染并在调整后失效，窄宽度不会溢出", () => {
	const stepper = makeStepper("Lines", 2, { min: 1, max: 3, step: 1 }, null, () => {});
	const first = stepper.render(40);
	assert.equal(stepper.render(40), first);
	stepper.handleInput?.("+");
	assert.notEqual(stepper.render(40), first);
	for (const width of [1, 5, 20]) assert.ok(stepper.render(width).every((line) => visibleWidth(line) <= width));
});
