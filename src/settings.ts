/** 配置交互界面与数值编辑器。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Key, SettingsList, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, SettingItem } from "@earendil-works/pi-tui";
import { config, saveConfig } from "./config.js";
import { runtime } from "./state.js";

export const CONFIG_KEYS = [
	{
		id: "maxGroupEntries",
		label: "Max collapsed entries",
		description: "Maximum entries shown in collapsed group",
		min: 1,
		max: 30,
		step: 1,
	},
] as const;

export function makeStepper(
	title: string,
	initial: number,
	meta: { min: number; max: number; step: number },
	theme: any,
	done: (value?: string) => void,
): Component {
	let value = initial;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const fg = (color: string, t: string) => theme?.fg?.(color, t) ?? t;

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const barLen = Math.max(1, Math.min(width - 10, 40));
			const ratio = (value - meta.min) / Math.max(1, meta.max - meta.min);
			const filled = Math.round(ratio * barLen);
			const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
			const titleText = theme?.bold ? theme.bold(title) : title;
			cachedLines = [
				fg("accent", titleText),
				"",
				`  ${fg("accent", String(value))}`,
				`  ${fg("muted", bar)}`,
				"",
				fg("dim", "  ◀ ▶ / − +  adjust    Enter  save    Esc  cancel"),
			].map((line) => truncateToWidth(line, Math.max(1, width)));
			cachedWidth = width;
			return cachedLines;
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.down) || data === "-" || data === "_") {
				value = Math.max(meta.min, value - meta.step);
			} else if (matchesKey(data, Key.right) || matchesKey(data, Key.up) || data === "+" || data === "=") {
				value = Math.min(meta.max, value + meta.step);
			} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				done(String(value));
				return;
			} else if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
			cachedWidth = undefined;
		},
		invalidate(): void {
			cachedWidth = undefined;
		},
	};
}

export function registerConfigCommand(pi: ExtensionAPI): void {
	pi.registerCommand("compact-ui-config", {
		description: "Interactive compact-ui settings (arrows to select, Enter to adjust, Esc to close)",
		handler: async (_args, ctx) => {
			// Non-TUI modes (print/json) can't show the interactive menu.
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`compact: maxGroupEntries=${config.maxGroupEntries}`,
					"info",
				);
				return;
			}

			const changed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
				let anyChanged = false;
				const items: SettingItem[] = CONFIG_KEYS.map((meta) => ({
					id: meta.id,
					label: meta.label,
					currentValue: String((config as any)[meta.id]),
					description: meta.description,
					submenu: (currentValue: string, subDone: (value?: string) => void) =>
						makeStepper(meta.label, Number(currentValue), meta, theme, subDone),
				}));
				const settingsList = new SettingsList(
					items,
					Math.min(items.length, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Persist and refresh the live groups when SettingsList commits a change.
						(config as any)[id] = Number(newValue);
						saveConfig();
						anyChanged = true;
						for (const g of runtime.groups) g.invalidate();
					},
					() => done(anyChanged),
				);
				return {
					render(width: number) {
						return settingsList.render(width);
					},
					invalidate() {
						settingsList.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			if (changed) {
				ctx.ui.notify("compact-ui settings saved", "info");
			}
		},
	});
}
