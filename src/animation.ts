/** 动画调度与终端鼠标状态清理。 */
import { spinnerStart, THINKING_SPINNER, SPINNER_MS } from "./constants.js";
import { runtime } from "./state.js";

export function thinkingSpinnerFrame(now = Date.now()): { frame: string; color: string } {
	const index =
		Math.floor((now - spinnerStart) / THINKING_SPINNER.intervalMs) % THINKING_SPINNER.rawFrames.length;
	return {
		frame: THINKING_SPINNER.rawFrames[index]!,
		color: THINKING_SPINNER.colorKeys[index]!,
	};
}

export function disableMouseTracking(): void {
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[?1006l\x1b[?1004l\x1b[?1002l\x1b[?1000l");
	}
}

process.on("exit", disableMouseTracking);

export function scheduleAnimation(): void {
	if (runtime.animTimer) return;
	runtime.animTimer = setTimeout(() => {
		runtime.animTimer = null;
		let any = false;
		for (const g of runtime.groups) {
			if (g.needsAnimation()) {
				any = true;
				break;
			}
		}
		if (any && runtime.capturedTui) {
			runtime.capturedTui.requestRender();
		}
	}, [...runtime.groups].some((group) => group.hasPending()) ? SPINNER_MS : THINKING_SPINNER.intervalMs);
}
