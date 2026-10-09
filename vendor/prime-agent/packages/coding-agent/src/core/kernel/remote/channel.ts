/**
 * A numbered, acknowledged message stream that outlives the socket carrying it.
 *
 * Both ends of the remote kernel use one: the loop (link.ts) and the kernel server
 * (server.ts). Each outgoing message gets the next sequence number and stays in the
 * outbox until the peer acknowledges it. When the socket drops, the channel simply
 * stops writing; when a new socket attaches, the peer says the last sequence it
 * received (hello.resume / welcome.resume) and everything after that is replayed in
 * order. Incoming duplicates — the replay of something that arrived just before the
 * drop — are dropped by sequence number.
 *
 * Not responsible for: the socket itself, authentication, heartbeats, or deciding
 * when a session is lost. Those belong to the endpoint that owns the channel.
 */
import { type DataFrame, encodeFrame, ProtocolError } from "./protocol.js";

export interface ChannelSink {
	send(raw: string): void;
}

export interface ReliableChannelOptions<In> {
	onMessage: (message: In) => void;
	/** Called when an ack should go out; the owner decides the control frame. */
	onAckDue?: (seq: number) => void;
	/** Send an ack after this many unacknowledged incoming messages. Default 32. */
	ackEvery?: number;
	/** ...or after this long, whichever is first. Default 500 ms. */
	ackDelayMs?: number;
	/** Refuse to buffer more than this many bytes for a detached peer. Default 256 MiB. */
	maxBufferedBytes?: number;
}

interface Pending {
	seq: number;
	raw: string;
}

export class ReliableChannel<In, Out> {
	private sink?: ChannelSink;
	private outSeq = 0;
	private inSeq = 0;
	private ackedByPeer = 0;
	private lastAckSent = 0;
	private readonly outbox: Pending[] = [];
	private bufferedBytes = 0;
	private ackTimer?: ReturnType<typeof setTimeout>;
	private overflowed = false;

	constructor(private readonly options: ReliableChannelOptions<In>) {}

	/** Highest contiguous sequence received from the peer. */
	get received(): number {
		return this.inSeq;
	}

	/** Messages sent but not yet acknowledged. */
	get unacked(): number {
		return this.outbox.length;
	}

	get isAttached(): boolean {
		return this.sink !== undefined;
	}

	/** True once the outbox had to drop data: the session can no longer be resumed faithfully. */
	get isBroken(): boolean {
		return this.overflowed;
	}

	/** Throws, without using up a sequence number, when `message` cannot be encoded. */
	send(message: Out): void {
		const seq = this.outSeq + 1;
		const raw = encodeFrame<Out>({ t: "d", seq, m: message });
		this.outSeq = seq;
		this.outbox.push({ seq, raw });
		this.bufferedBytes += raw.length;
		if (!this.sink && this.bufferedBytes > (this.options.maxBufferedBytes ?? 256 * 1024 * 1024)) {
			// Dropping silently would resume into a stream with a hole in it. Break the
			// session instead; the owner reports it unresumable on the next attach.
			this.overflowed = true;
			this.outbox.length = 0;
			this.bufferedBytes = 0;
			return;
		}
		this.sink?.send(raw);
	}

	/** Deliver a data frame from the peer. Returns false for a duplicate. */
	receive(frame: DataFrame<In>): boolean {
		if (frame.seq <= this.inSeq) return false;
		if (frame.seq !== this.inSeq + 1) {
			throw new ProtocolError(`sequence gap: expected ${this.inSeq + 1}, got ${frame.seq}`);
		}
		this.inSeq = frame.seq;
		this.scheduleAck();
		this.options.onMessage(frame.m);
		return true;
	}

	/** The peer has everything up to and including `seq`. */
	acknowledge(seq: number): void {
		if (seq <= this.ackedByPeer) return;
		this.ackedByPeer = Math.min(seq, this.outSeq);
		let drop = 0;
		while (drop < this.outbox.length && this.outbox[drop].seq <= this.ackedByPeer) {
			this.bufferedBytes -= this.outbox[drop].raw.length;
			drop++;
		}
		if (drop > 0) this.outbox.splice(0, drop);
	}

	/**
	 * Start writing to a (new) socket. `peerReceived` is the last sequence the peer
	 * says it has; everything after it is replayed before anything new is sent.
	 */
	attach(sink: ChannelSink, peerReceived: number): void {
		this.acknowledge(peerReceived);
		this.sink = sink;
		for (const pending of this.outbox) sink.send(pending.raw);
	}

	detach(): void {
		this.sink = undefined;
		this.clearAckTimer();
	}

	/** Record that an ack for everything received so far has gone out (piggybacked on a heartbeat). */
	markAcked(): void {
		this.lastAckSent = this.inSeq;
		this.clearAckTimer();
	}

	private scheduleAck(): void {
		const due = this.inSeq - this.lastAckSent;
		if (due >= (this.options.ackEvery ?? 32)) {
			this.flushAck();
			return;
		}
		if (this.ackTimer) return;
		this.ackTimer = setTimeout(() => this.flushAck(), this.options.ackDelayMs ?? 500);
		this.ackTimer.unref?.();
	}

	private flushAck(): void {
		this.clearAckTimer();
		if (this.inSeq === this.lastAckSent || !this.sink) return;
		this.lastAckSent = this.inSeq;
		this.options.onAckDue?.(this.inSeq);
	}

	private clearAckTimer(): void {
		if (this.ackTimer) clearTimeout(this.ackTimer);
		this.ackTimer = undefined;
	}
}
