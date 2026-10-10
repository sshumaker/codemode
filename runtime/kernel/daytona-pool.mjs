/**
 * A warm pool of Daytona sandboxes for the daytona kernel backend.
 */
import { randomBytes } from "node:crypto";

const SILENT = { info() {}, warn() {} };

/**
 * A few sandboxes created ahead of time, fully ready while they wait: runtime
 * installed, kernel server running, every upload done, so a new conversation's first
 * turn skips the 27-35 s cold `ensure()` (when the key has no snapshot permission). Pool
 * sandboxes carry the pool's labels (`pool=warm` and an owner) under a synthetic
 * conversation id (`pool-<hex>`). A claim relabels one to the real conversation and, at
 * the same time, asks its server whether it is still up; when it is, the connection info
 * from warm time is the conversation's, and no setup step runs again (measured 1.5-8 s
 * when the claim re-ran ensure()).
 *
 * Owns: filling to `size`, adopting its own leftovers after a restart, holding pool
 * sandboxes awake, claiming, and deleting what is left on close.
 * Not responsible for: the conversation's sandbox after a claim (the backend's provider).
 */
export class WarmPool {
	constructor(opts) {
		this.provider = opts.provider;
		this.size = opts.size;
		this.labelsFor = opts.labelsFor;
		this.log = opts.log ?? SILENT;
		this.ready = [];
		this.inFlight = new Set();
		/** Claims waiting for a sandbox that is already warming (sooner than a cold create). */
		this.waiters = [];
		this.closed = false;
		this.started = undefined;
		/**
		 * How long a claim waits for a sandbox already warming. A cold create starts later and
		 * does the same work, so it is never sooner; this only bounds a warm that hangs.
		 */
		this.warmWaitMs = opts.warmWaitMs ?? 180_000;
	}

	get readyCount() {
		return this.ready.length;
	}

	/** Adopt leftovers from a previous process (same owner), then fill. Idempotent. */
	start() {
		this.started ??= this.adopt()
			.catch((err) => this.log.warn("warm pool: could not list leftovers", { error: String(err) }))
			.then(() => this.fill());
		return this.started;
	}

	async adopt() {
		const leftovers = (await this.provider.listOrphans()).filter(
			(o) => o.conversationId?.startsWith("pool-") && o.state !== "destroying" && o.state !== "destroyed",
		);
		for (const [i, o] of leftovers.entries()) {
			const id = o.conversationId;
			if (i >= this.size) {
				void this.provider.destroy(id).catch(() => {});
				continue;
			}
			await this.warm(id);
		}
		if (leftovers.length)
			this.log.info("warm pool: adopted leftovers", {
				adopted: Math.min(leftovers.length, this.size),
				removed: Math.max(0, leftovers.length - this.size),
			});
	}

	fill() {
		while (!this.closed && this.ready.length + this.inFlight.size < this.size) {
			void this.warm(`pool-${randomBytes(5).toString("hex")}`);
		}
	}

	async warm(id) {
		this.inFlight.add(id);
		const t0 = Date.now();
		try {
			const info = await this.provider.ensure(id);
			const sandbox = await this.provider.find(id);
			if (!sandbox) throw new Error("the sandbox vanished after ensure");
			if (this.closed) {
				await this.provider.destroy(id).catch(() => {});
				return;
			}
			const entry = { id, info, sandbox, release: this.provider.keepAlive(id, { intervalMs: 60_000 }) };
			const waiter = this.waiters.shift();
			if (waiter) waiter(entry);
			else this.ready.push(entry);
			this.log.info("warm pool: sandbox ready", { id, ms: Date.now() - t0, ready: this.ready.length });
		} catch (err) {
			this.log.warn("warm pool: could not warm a sandbox", { id, error: String(err) });
			// A claim waiting on this one would otherwise sit out its whole wait; send it cold now.
			if (this.waiters.length > this.inFlight.size - 1) this.waiters.shift()?.(undefined);
			await this.provider.destroy(id).catch(() => {});
		} finally {
			this.inFlight.delete(id);
		}
	}

	/**
	 * Relabel a ready sandbox to `conversationId` and check its server, in parallel;
	 * undefined if none is ready (the caller creates one cold). Label search lags a
	 * relabel, so the caller should bind the id on its own provider rather than search.
	 */
	async claim(conversationId) {
		const entry = this.ready.shift() ?? (await this.nextWarming());
		if (!entry) {
			this.fill();
			return undefined;
		}
		entry.release();
		const t0 = Date.now();
		try {
			const [, health] = await Promise.all([
				entry.sandbox.setLabels(this.labelsFor(conversationId)),
				this.provider.verify(entry.info).catch(() => undefined),
			]);
			this.log.info("warm pool: claimed", {
				conversationId,
				sandboxId: entry.sandbox.id,
				verified: !!health,
				ms: Date.now() - t0,
				left: this.ready.length,
			});
			return { sandboxId: entry.sandbox.id, info: health ? entry.info : undefined };
		} catch (err) {
			this.log.warn("warm pool: claim failed; creating cold", { conversationId, error: String(err) });
			void this.provider.destroy(entry.id).catch(() => {});
			return undefined;
		} finally {
			this.fill();
		}
	}

	/** A sandbox that is warming now lands sooner than a cold create would; wait for it (bounded). */
	nextWarming(timeoutMs = this.warmWaitMs) {
		if (this.closed || this.inFlight.size <= this.waiters.length) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const waiter = (e) => {
				clearTimeout(timer);
				resolve(e);
			};
			const timer = setTimeout(() => {
				const i = this.waiters.indexOf(waiter);
				if (i >= 0) this.waiters.splice(i, 1);
				resolve(undefined);
			}, timeoutMs);
			timer.unref();
			this.waiters.push(waiter);
		});
	}

	/** Stop refilling and delete every ready sandbox. In-flight ones delete themselves when they land. */
	async close(timeoutMs = 10_000) {
		this.closed = true;
		for (const w of this.waiters.splice(0)) w(undefined);
		const entries = this.ready.splice(0);
		for (const e of entries) e.release();
		const deletes = Promise.allSettled(entries.map((e) => this.provider.destroy(e.id)));
		await Promise.race([deletes, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
	}
}
