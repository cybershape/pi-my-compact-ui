import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/** Exercise Pi's actual TypeScript loader, not only tsc-emitted JavaScript. */
test("Pi 实际加载器可以加载拆分后的 TypeScript 入口并注册扩展", async () => {
	const agentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const loaderURL = new URL("./core/extensions/loader.js", agentEntry);
	const { loadExtensions } = await import(loaderURL.href);
	const entryPath = fileURLToPath(new URL("../../index.ts", import.meta.url));
	const result = await loadExtensions([entryPath], process.cwd());
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	assert.deepEqual([...result.extensions[0].commands.keys()], ["compact-inspect", "compact-ui-config"]);
	assert.ok(result.extensions[0].handlers.has("message_update"));
});

test("Pi 实际加载器可以加载构建后的 dist 入口并注册扩展", async () => {
	const agentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const loaderURL = new URL("./core/extensions/loader.js", agentEntry);
	const { loadExtensions } = await import(loaderURL.href);
	const entryPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
	const result = await loadExtensions([entryPath], process.cwd());
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	assert.deepEqual([...result.extensions[0].commands.keys()], ["compact-inspect", "compact-ui-config"]);
	assert.ok(result.extensions[0].handlers.has("message_update"));
});
