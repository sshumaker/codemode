/**
 * Slim build: the HTML tool renderer has been removed alongside the exporter.
 * Installed by scripts/slim-prime.mjs.
 *
 * agent-session.ts builds one of these eagerly and hands it to the exporter, so
 * the factory stays and returns a renderer that declines every tool — which is
 * already the contract for a tool with no custom renderer.
 */

import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition } from "../extensions/types.js";

export interface ToolHtmlRendererDeps {
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	theme: Theme;
	cwd: string;
	width?: number;
}

export interface ToolHtmlRenderer {
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

export function createToolHtmlRenderer(_deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	return {
		renderCall: () => undefined,
		renderResult: () => undefined,
	};
}
