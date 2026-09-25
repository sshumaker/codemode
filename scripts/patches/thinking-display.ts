/**
 * HARNESS_THINKING_DISPLAY: how Anthropic returns adaptive/extended thinking, when
 * the caller did not say. "summarized" (upstream's default here) holds every
 * thinking delta until the model has finished thinking, so a UI that only needs to
 * know thinking is under way waits for all of it: measured on Sonnet 5 at effort
 * medium, first delta 5.45 s summarized vs 1.7 s omitted. "omitted" streams an
 * empty thinking block at once (the signature still round-trips). Anything else,
 * or unset, keeps upstream's default.
 */
function harnessThinkingDisplay(): AnthropicThinkingDisplay | undefined {
	const value = process.env.HARNESS_THINKING_DISPLAY;
	return value === "omitted" || value === "summarized" ? value : undefined;
}
