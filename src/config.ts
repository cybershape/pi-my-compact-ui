/** Persist configuration with injectable filesystem access. */
import { join } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync } from "fs";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "compact-ui.json");

export const DEFAULT_CONFIG = { maxGroupEntries: 5 };

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
		const loaded = JSON.parse(read(path, 'utf-8'));
		return { maxGroupEntries: loaded.maxGroupEntries ?? DEFAULT_CONFIG.maxGroupEntries };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
