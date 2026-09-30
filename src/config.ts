/** 配置持久化；通过可注入的读写器隔离文件系统。 */
import { join } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync } from "fs";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "compact-ui.json");

export const DEFAULT_CONFIG = { expandedToolLines: 5, expandedThinkingLines: 10, maxGroupEntries: 5 };

export const config = loadConfig(CONFIG_PATH);

export function saveConfig(
	values = config,
	path = CONFIG_PATH,
	write: (path: string, data: string) => void = writeFileSync,
): void {
	try {
		write(path, JSON.stringify(values, null, 2) + "\n");
	} catch {
		// ignore
	}
}

/** Read configuration without coupling tests to the user's filesystem. */
export function loadConfig(path: string, read: (path: string, encoding: 'utf-8') => string = readFileSync): typeof DEFAULT_CONFIG {
	try {
		return { ...DEFAULT_CONFIG, ...JSON.parse(read(path, 'utf-8')) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
