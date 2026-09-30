/** 兼容不同 Pi/TUI 模块实例的组件识别与原生工具渲染抑制。 */
import { Container, Spacer, Markdown, Text } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { ToolGroupComponent } from "./tool-group.js";
import { TOOL_RENDER_PATCH_KEY, PARENT_KEY } from "./constants.js";

export function isContainer(val: any): val is Container {
	return Boolean(
		val &&
			(val instanceof Container ||
				val.constructor?.name === "Container" ||
				(Array.isArray((val as any).children) && typeof (val as any).addChild === "function")),
	);
}

export function isAssistantMessage(val: any): val is AssistantMessageComponent {
	return Boolean(
		val &&
			(val instanceof AssistantMessageComponent ||
				val.constructor?.name === "AssistantMessageComponent"),
	);
}

export function isToolExecution(val: any): val is ToolExecutionComponent {
	return Boolean(
		val &&
			(val instanceof ToolExecutionComponent ||
				val.constructor?.name === "ToolExecutionComponent"),
	);
}

export function isSpacer(val: any): val is Spacer {
	return Boolean(val && (val instanceof Spacer || val.constructor?.name === "Spacer"));
}

export function isMarkdown(val: any): val is Markdown {
	return Boolean(val && (val instanceof Markdown || val.constructor?.name === "Markdown"));
}

export function isText(val: any): val is Text {
	return Boolean(val && (val instanceof Text || val.constructor?.name === "Text"));
}

export function isToolGroup(val: any): val is ToolGroupComponent {
	return Boolean(val && (val instanceof ToolGroupComponent || val.constructor?.name === "ToolGroupComponent"));
}

export function hideGroupedToolRender(tool: any): void {
	const prototype = tool ? Object.getPrototypeOf(tool) : undefined;
	if (!prototype || typeof prototype.render !== "function" || prototype[TOOL_RENDER_PATCH_KEY]) return;
	const original = prototype.render as (this: any, width: number) => string[];
	const installed = function (this: any, width: number): string[] {
		if (this?.[PARENT_KEY]) return [];
		return original.call(this, width);
	};
	prototype.render = installed;
	prototype[TOOL_RENDER_PATCH_KEY] = { original, installed };
}
