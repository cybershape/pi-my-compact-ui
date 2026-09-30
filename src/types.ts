/** 思考、工具、预览与组件补丁的共享类型。 */
import type { ToolGroupComponent } from "./tool-group.js";

export type ThinkingEntry = {
	kind: "thinking";
	id: number;
	text: string;
	tokens: number;
	tokensExact: boolean;
	/** Still streaming — renders the animated spinner instead of the done mark. */
	active: boolean;
	/** Group currently owning this entry, used for targeted invalidation. */
	owner: ToolGroupComponent | null;
};

export type GroupEntry = { kind: "tool"; tool: any } | ThinkingEntry;

export type ToolStatus = "pending" | "success" | "error";

export type PreparingTool = {
	toolName: string;
	toolCallId: string;
	args: any;
	isPartial: true;
	_preparing: true;
	_contentIndex: number;
	owner: ToolGroupComponent | null;
};

export type MarkdownPreview = {
	source: string;
	width: number;
	maxLines: number;
	lines: string[];
	truncated: boolean;
};

export type PatchState = {
	active: boolean;
	original: { addChild: Function; removeChild: Function; clear: Function };
	installed: { addChild: Function; removeChild: Function; clear: Function };
	prototype: any;
};

export type AssistantContentState = {
	/** Sealed groups keyed by the visible Markdown block they precede. */
	anchors: Map<number, ToolGroupComponent>;
	/** Visible Markdown ordinal while AssistantMessageComponent rebuilds. */
	nextTextOrdinal: number;
	/** Turn-duration divider bound to the final visible Markdown ordinal. */
	finalDivider?: { ordinal: number; component: any };
};
