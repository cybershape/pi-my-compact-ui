/** 渲染常量与跨热重载稳定的补丁标记。 */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const SPINNER_MS = 100;

export const THINKING_SPINNER = {
	rawFrames: ["·", "•", "●", "•"],
	intervalMs: 140,
	colorKeys: ["dim", "muted", "accent", "muted"],
} as const;

export const GROUP_PADDING_X = 1;

export const GROUP_PADDING_RIGHT = 2;

export const spinnerStart = Date.now();

export const PARENT_KEY = Symbol.for("compact-ui.group-parent");

export const PATCH_KEY = Symbol.for("compact-ui.group-patch");

export const COMPACTION_STYLE_PATCH_KEY = Symbol.for("compact-ui.compaction-style-patch");

export const ASSISTANT_THINKING_PATCH_KEY = Symbol.for("compact-ui.assistant-thinking-patch");

export const IS_STREAMING_COMP = Symbol.for("compact-ui.is-streaming-comp");

export const GROUP_MOUNT = Symbol.for("compact-ui.group-mount");

export const TOOL_RENDER_PATCH_KEY = Symbol.for("compact-ui.tool-render-patch");

export const LIVE_ASSISTANT_KEY = Symbol.for("compact-ui.live-assistant");
