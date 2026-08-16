/**
 * Slim build: the session-to-HTML exporter has been removed.
 * Installed by scripts/slim-prime.mjs.
 *
 * The original rendered a session into a standalone shareable web page, and
 * shipped ~4,200 lines of bundled highlight.js / marked / CSS / JS assets into
 * `dist` to do it. It is a product share feature; nothing on the print path or
 * in either benchmark arm calls it.
 *
 * The two exported entry points throw rather than return an empty file: a
 * caller asking for an export and silently getting nothing is the
 * plausible-looking-result failure this repo keeps getting bitten by.
 */

import type { AgentState } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.js";

const REMOVED = "HTML export was removed in this build (scripts/slim-prime.mjs)";

/**
 * Interface for rendering custom tools to HTML.
 * Retained because agent-session.ts holds a nullable field of this type.
 */
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

export interface ExportOptions {
	outputPath?: string;
	themeName?: string;
	toolRenderer?: ToolHtmlRenderer;
}

export async function exportSessionToHtml(
	_sm: SessionManager,
	_state?: AgentState,
	_options?: ExportOptions | string,
): Promise<string> {
	throw new Error(REMOVED);
}

export async function exportFromFile(_inputPath: string, _options?: ExportOptions | string): Promise<string> {
	throw new Error(REMOVED);
}
