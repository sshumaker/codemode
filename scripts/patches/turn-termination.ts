/**
 * Harness: the calls a response made AFTER a turn-ending result (jobs.wait) do not
 * run. The wait ends the turn for the same reason it ends the cell: anything after it
 * would read state that has not changed yet, before any waiting. Each still gets a
 * result — every tool call must have one — saying it was skipped and why, so the model
 * reads it on waking and can issue it again. See scripts/neutralize-prime.mjs.
 */
export const SKIPPED_AFTER_TURN_END =
	"[not run: an earlier call in this response ended the turn (jobs.wait), so this call was skipped. " +
	"Issue it again after you are woken if you still need it.]";

async function skipToolCallsAfterTurnEnd(
	toolCalls: AgentToolCall[],
	messages: ToolResultMessage[],
	emit: AgentEventSink,
): Promise<void> {
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(SKIPPED_AFTER_TURN_END),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
}
