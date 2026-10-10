/**
 * Placement routing: each conversation's kernel runs where it was placed when it
 * started, `cloud` (the host's configured backend: Daytona, local srt) or `device` (the
 * user's own computer, through a device backend the app supplies).
 */

export function isPlacement(v) {
	return v === "cloud" || v === "device";
}

/**
 * Routes each conversation to its placement. A conversation keeps its placement for
 * life, since a kernel's state cannot move between machines. Everything that is about
 * the cloud backend as a whole (its warm pool, sweeping idle sandboxes) goes to it alone.
 *
 * Owns: choosing the backend per conversation (the caller's `ctx.placement`, else
 * `lookup`, else cloud) and remembering it for a destroy after the conversation's
 * record is gone.
 * Not responsible for: how a device is reached (the app's device backend), or where
 * placements are stored (`lookup`).
 */
export class PlacedKernelBackend {
	constructor(opts) {
		this.cloud = opts.cloud;
		this.device = opts.device;
		this.lookup = opts.lookup;
		this.name = opts.cloud.name;
		/** What each opened conversation was, for a destroy that runs after its record is gone. */
		this.opened = new Map();
	}

	placementOf(conversationId) {
		return this.opened.get(conversationId)?.placement ?? this.lookup(conversationId)?.placement ?? "cloud";
	}

	start(opts) {
		return this.cloud.start?.(opts) ?? Promise.resolve();
	}

	open(ctx) {
		const placement = ctx.placement ?? this.lookup(ctx.conversationId)?.placement ?? "cloud";
		this.opened.set(ctx.conversationId, { placement, userId: ctx.userId });
		if (placement !== "device") return this.cloud.open(ctx);
		if (!this.device) return Promise.reject(new Error("this host has no device backend; the conversation is placed on a device"));
		return this.device.open(ctx);
	}

	async destroy(conversationId) {
		const known = this.opened.get(conversationId) ?? this.lookup(conversationId);
		this.opened.delete(conversationId);
		if (known?.placement === "device") await this.device?.destroyFor(known.userId, conversationId);
		else await this.cloud.destroy?.(conversationId);
	}

	sweepIdle(opts) {
		return this.cloud.sweepIdle?.(opts) ?? Promise.resolve({ deleted: [], kept: 0 });
	}

	drain() {
		return this.cloud.drain?.() ?? Promise.resolve();
	}

	async shutdown() {
		await Promise.allSettled([this.cloud.shutdown?.(), this.device?.shutdown()]);
	}
}
