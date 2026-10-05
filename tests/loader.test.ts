import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("Pi's loader loads the bundled TypeScript entry declared in the manifest", async () => {
	const agentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const loaderURL = new URL("./core/extensions/loader.js", agentEntry);
	const { loadExtensions } = await import(loaderURL.href);
	const packageURL = new URL("../../package.json", import.meta.url);
	const manifest = JSON.parse(readFileSync(packageURL, "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./dist/extension.ts"]);
	assert.equal(manifest.main, undefined);
	assert.equal(manifest.types, undefined);
	assert.equal(manifest.exports, undefined);
	assert.deepEqual(manifest.files, ["LICENSE", "README.md", "dist/extension.ts", "dist/extension.ts.map"]);
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.equal(manifest.peerDependencies[name], "^1.0.3");
		assert.equal(manifest.peerDependenciesMeta[name].optional, true);
		assert.equal(manifest.devDependencies[name], "^1.0.3");
	}
	const entryPath = fileURLToPath(new URL(manifest.pi.extensions[0], packageURL));
	const result = await loadExtensions([entryPath], process.cwd());
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	assert.deepEqual([...result.extensions[0].commands.keys()], ["compact-inspect", "compact-ui-config"]);
	assert.ok(result.extensions[0].handlers.has("message_update"));
});

test("the bundled Pi loader reuses host components without native extension imports", () => {
	const agentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const bundleURL = new URL("./bundle/index.js", agentEntry);
	const entryPath = fileURLToPath(new URL("../../dist/extension.ts", import.meta.url));
	const script = `
		import assert from "node:assert/strict";
		import { createRequire } from "node:module";
		const host = await import(${JSON.stringify(bundleURL.href)});
		const require = createRequire(import.meta.url);
		const cachedBefore = new Set(Object.keys(require.cache));
		const prototype = host.AssistantMessageComponent.prototype;
		const originalUpdate = prototype.updateContent;
		const result = await host.discoverAndLoadExtensions(
			[${JSON.stringify(entryPath)}], process.cwd(),
			${JSON.stringify(fileURLToPath(new URL("../../.test-build/no-agent", import.meta.url)))},
		);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.deepEqual([...result.extensions[0].commands.keys()], ["compact-inspect", "compact-ui-config"]);
		const patch = prototype[Symbol.for("compact-ui.assistant-thinking-patch")];
		assert.ok(patch, "the extension must patch the host assistant prototype");
		assert.equal(patch.originalUpdateContent, originalUpdate);
		assert.equal(prototype.updateContent, patch.installedUpdateContent);
		const containerPrototype = Object.getPrototypeOf(prototype);
		assert.ok(globalThis[Symbol.for("compact-ui.group-patch")].has(containerPrototype));
		assert.ok(host.CompactionSummaryMessageComponent.prototype[Symbol.for("compact-ui.compaction-style-patch")]);
		const newlyLoadedPiFiles = Object.keys(require.cache).filter((path) =>
			!cachedBefore.has(path) && /node_modules\\/[@]earendil-works\\/pi-(coding-agent|tui)\\/dist\\/(?!bundle\\/)/.test(path)
		);
		assert.deepEqual(newlyLoadedPiFiles, [], "a second unbundled Pi must not be loaded");
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: process.cwd(),
		env: { ...process.env, JITI_FS_CACHE: "false", JITI_DEBUG: "1", NODE_DISABLE_COMPILE_CACHE: "1" },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	const debugOutput = (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(debugOutput, /\[transpile\].*dist\/extension\.ts/);
	assert.match(debugOutput, /\[virtual\] @earendil-works\/pi-coding-agent/);
	assert.doesNotMatch(debugOutput, /\[native\].*\[import\].*dist\/extension\.ts/);
});
