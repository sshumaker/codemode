/**
 * The boundary, as one module every runner shares.
 *
 * Three things make up the posture, and they only mean anything together:
 *
 *   srt sandbox      what the kernel may read, write and reach
 *   env allow-list   what the kernel may INHERIT (built, not scrubbed)
 *   egress proxy     the one route out, and the control surface spawn() uses
 *
 * It lives here rather than in each runner because this project has already
 * paid for the alternative: a hand-rolled equivalent of a harness component
 * stops measuring the harness and starts measuring the clone, and the
 * divergences are invisible until one of them costs a task. The eval loop and
 * the benchmark runners must be able to say they ran the SAME boundary, which
 * is only true if there is one implementation of it.
 *
 * Whether the posture is on is no longer any caller's SILENT choice: the kernel
 * fails closed (vendor kernel/index.ts, via scripts/neutralize-prime.mjs) and
 * refuses to start without srt settings unless HARNESS_KERNEL_SANDBOX=off says
 * bare was chosen on purpose. What stays with the caller is which explicit
 * condition to run -- for the benchmark runners it is measured, so it must be
 * named in the run's provenance either way.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Blocking sleep without a subprocess; this module's startup polling is sync. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EGRESS_SRC = join(ROOT, "proxy/egress");

/**
 * What the kernel is allowed to INHERIT.
 *
 * An allow-list, not a scrub. The deny-list posture names what to remove, so it
 * is only ever as good as the list — it fails open, and the next credential to
 * appear in the loop's environment is in the kernel the day it is added,
 * silently. This names what may survive instead: the kernel's environment is
 * BUILT from these, so anything unlisted is absent by construction, including
 * things nobody has thought of yet.
 *
 * The list is short because the kernel needs little: enough to run a process
 * (PATH/HOME/TMPDIR and the locale), the IPython profile that installs the
 * prelude, and the HARNESS_* settings that ARE the runtime's configuration —
 * job directory, wait ceilings, the subagent model and CLI, the egress proxy
 * and its token. `HARNESS_*` is a prefix, so a new runtime setting works
 * without an edit here while a new credential still does not.
 */
export const KERNEL_ENV_ALLOW = [
	"PATH", "HOME", "TMPDIR", "TMP", "TEMP",
	"USER", "LOGNAME", "SHELL", "TERM", "TZ",
	"LANG", "LC_ALL", "LC_CTYPE",
	"IPYTHONDIR",
	"HARNESS_*",
].join(",");

/**
 * Every prefix the interpreter is reachable through: the venv, and the base
 * install its `bin/python` symlinks into (where the stdlib actually lives).
 *
 * EVERY hop of the symlink chain, not just the endpoint, because seatbelt
 * matches the path as SPELLED rather than as resolved. Measured: uv's venv
 * points at `.../uv/python/cpython-3.11-macos-aarch64-none`, itself a symlink
 * to `cpython-3.11.15-...`; allowing only the realpath produced
 * "/bin/bash: .../python: Operation not permitted" — the kernel could not exec
 * its own interpreter, and every probe in sandbox-check failed at once, which
 * reads as a broken sandbox rather than as one missing spelling.
 */
export function pythonPrefixes(python) {
	const roots = new Set([resolve(python, "../..")]);
	let p = python;
	for (let hop = 0; hop < 8; hop++) {
		let target;
		try {
			target = readlinkSync(p);
		} catch {
			break; // not a symlink, or gone: end of the chain
		}
		p = resolve(dirname(p), target);
		roots.add(resolve(p, "../.."));
	}
	try {
		roots.add(resolve(realpathSync(python), "../.."));
	} catch {
		// No venv yet (the first run builds it); the spellings above still hold.
	}
	return [...roots];
}

/**
 * The srt settings the kernel runs under.
 *
 * Reads are an allow-list expressed the only way srt (0.0.71) offers: reads are
 * permitted everywhere by default and the sole shape is deny-then-allow, so
 * `denyRead` takes the region holding every credential (the whole home
 * directory: ~/.ssh, ~/.aws, ~/.claude, and the loop's own env file) and
 * `allowRead` names back what the kernel needs. System directories stay
 * readable because python's interpreter and dyld need them and no credential of
 * ours is there.
 *
 * `allowLocalBinding` is doing more work than its name suggests, ON MACOS.
 * ipykernel speaks ZMQ over loopback so it cannot be false, and measured under
 * seatbelt it is also what permits an outbound connect to 127.0.0.1 — which is
 * how the kernel reaches the egress proxy. With it false that connect fails
 * "Operation not permitted"; external egress stays blocked either way (403 at
 * srt's own proxy). So on macOS loopback is open as a whole, not just to our
 * port: the proxy's authority rests on its token, not on srt.
 *
 * THIS DOES NOT HOLD ON LINUX, and the difference is load-bearing for anything
 * hosted. There srt sandboxes through bubblewrap, which puts the process in its
 * own network namespace with only its own loopback — measured inside a container,
 * a POST to the proxy on 127.0.0.1 gets no connection at all while the proxy sits
 * there provably up and its audit log stays empty.
 *
 * The Linux form is therefore a UNIX SOCKET, which `allowAllUnixSockets` below
 * already permits: a socket is a path, and the sandbox shares the filesystem even
 * when it does not share the network namespace. `startEgress({ listen: "unix" })`
 * is the default there, and the proxy's address travels as `unix:<path>` (verified
 * inside a container: spawn 201 with the run's token, 401 with a wrong one, TCP
 * loopback still dead, api.anthropic.com still refused). The older
 * domain-alias form — alias the proxy in /etc/hosts, name it in `allowedDomains`
 * — also works and is the fallback; it costs a domain entry, which is a second
 * route out of the sandbox.
 *
 * So this block is portable, and the transport is what changes per platform: the
 * network section stays closed either way.
 */
export function srtSettings({ runDir, home, readable, writable = [] }) {
	return {
		filesystem: {
			// Allow-only: an empty list means no write access, so the default
			// direction is the safe one.
			allowWrite: [runDir, ...writable],
			denyWrite: [],
			denyRead: [home],
			allowRead: readable,
		},
		network: {
			// The kernel needs nothing off-box. Anything it reaches for is either
			// a tool-surface bypass or an accident, and both are worth recording.
			// The egress proxy is loopback, which this does not govern (see above).
			allowedDomains: [],
			deniedDomains: [],
			allowLocalBinding: true,
			allowAllUnixSockets: true,
		},
	};
}

// ---- the egress proxy -------------------------------------------------------

/**
 * Build once, reuse until the source changes.
 *
 * Keyed on source mtime rather than a hash because the inputs are four files in
 * one directory and a stat is free; the failure mode being avoided is a `go
 * build` per benchmark task, which at pool concurrency is minutes of wall clock
 * spent recompiling an unchanged binary.
 */
export function buildEgressBinary({ out = join(ROOT, ".run/bin/egress") } = {}) {
	const sources = readdirSync(EGRESS_SRC)
		.filter((f) => f.endsWith(".go") || f === "go.mod")
		.map((f) => statSync(join(EGRESS_SRC, f)).mtimeMs);
	const newest = Math.max(...sources);
	if (existsSync(out) && statSync(out).mtimeMs > newest) return out;

	mkdirSync(dirname(out), { recursive: true });
	const r = spawnSync("go", ["build", "-o", out, "."], { cwd: EGRESS_SRC, encoding: "utf8" });
	if (r.error?.code === "ENOENT") {
		throw new Error("the egress proxy needs `go` on PATH to build; install go or run without the posture");
	}
	if (r.status !== 0) throw new Error(`go build (egress) failed:\n${r.stderr ?? ""}`);
	return out;
}

/**
 * Which door this platform's sandbox can actually reach.
 *
 * macOS: TCP loopback, which works because `allowLocalBinding` is forced true by
 * ipykernel's ZMQ (see srtSettings) and is what every number in docs/ was measured
 * over.
 *
 * Linux: the unix socket, and nothing else. bwrap gives the sandbox its own
 * network namespace, so the harness's 127.0.0.1 is not the sandbox's — measured
 * with the proxy provably up: no connection at all, empty audit log. The other
 * working form (alias the proxy in /etc/hosts, name it in `allowedDomains`) needs
 * a domain entry, and a domain entry is a second route out.
 *
 * A default per platform rather than a flag callers must remember, because the
 * point of this module is that every runner shares ONE boundary — a boundary that
 * depends on each caller getting a flag right is several boundaries.
 */
export const defaultEgressListen = () => (process.platform === "linux" ? "unix" : "tcp");

/**
 * sockaddr_un.sun_path: 104 bytes on macOS, 108 on Linux, so 104 is the portable
 * ceiling. Kept in step with proxy/egress/main.go's own constant by
 * bench/test/posture.test.mjs — a path this module hands out and the proxy then
 * refuses is a run that dies at bind with "invalid argument".
 */
const UNIX_PATH_MAX = 104;

/**
 * Where the run's socket lives: in the run directory, unless that is too long.
 *
 * Run directories are named after task, variant and run id and nest several levels
 * deep, so the ceiling is reachable in ordinary use rather than only in a
 * pathological case. The fallback is a short name under TMPDIR — which the sandbox
 * can also reach, since srtSettings already allows /tmp and TMPDIR for ipykernel's
 * connection file — at the cost of not sitting with the run's other artefacts.
 */
export function egressSocketPath(runDir, session = "run") {
	const inRun = join(runDir, "egress.sock");
	if (inRun.length < UNIX_PATH_MAX) return inRun;
	const short = join(tmpdir(), `egr-${session}-${process.pid}.sock`);
	if (short.length >= UNIX_PATH_MAX) {
		throw new Error(
			`no socket path fits the ${UNIX_PATH_MAX}-byte ceiling (tried ${inRun} and ${short}); ` +
				"use a shorter run directory or TMPDIR",
		);
	}
	return short;
}

/**
 * Start a per-run egress proxy and hand back the two variables the sandbox
 * needs to use it.
 *
 * `listen` is "tcp" (a port), "unix" (a socket) or "both", defaulting per platform
 * — see defaultEgressListen. "both" exists because the two doors share one handler
 * and one token, so a caller with a TCP client (an MCP SDK) and a sandboxed client
 * (the kernel) can serve each without two proxies.
 *
 * Port 0, not a fixed one: benchmark tasks run pooled, and a fixed port makes
 * concurrent runs fight over a boundary — the loser either fails to bind or,
 * worse, talks to the neighbour's proxy and writes spawn requests into the
 * neighbour's jobs directory. The proxy announces the port it got via
 * --addr-file and this polls for it.
 *
 * The token is minted per run by the binary itself, so no token outlives the
 * run that used it and none is ever written into a config file that gets
 * committed or copied.
 *
 * `routes` is passed through to the config verbatim. Empty is legitimate and
 * common: the eval tasks want spawn and nothing else.
 */
export function startEgress({
	runDir,
	spawnDir,
	routes = [],
	session = "run",
	env = process.env,
	waitMs = 15000,
	listen = defaultEgressListen(),
}) {
	if (!["tcp", "unix", "both"].includes(listen)) {
		throw new Error(`startEgress: listen must be tcp|unix|both, got ${JSON.stringify(listen)}`);
	}
	const bin = buildEgressBinary();
	const configPath = join(runDir, "egress-config.json");
	const tokensPath = join(runDir, "egress-tokens.txt");
	const addrPath = join(runDir, "egress-addr.txt");
	const auditPath = join(runDir, "egress-audit.jsonl");
	const logPath = join(runDir, "egress.log");

	writeFileSync(configPath, `${JSON.stringify({ routes, spawn_dir: spawnDir }, null, 2)}\n`);

	// A previous proxy's address file, in a run directory being reused, is a
	// working port number for a process that is gone. The poll below would read
	// it before the new proxy ever writes, and every probe would then dial a dead
	// port and be reported as BLOCKED — a boundary that looks airtight because
	// nothing was listening. Measured exactly that way against a re-run directory
	// before this line existed.
	rmSync(addrPath, { force: true });

	const socketPath = listen === "tcp" ? "" : egressSocketPath(runDir, session);

	const minted = spawnSync(bin, ["--mint", session], { encoding: "utf8" });
	if (minted.status !== 0) throw new Error(`egress --mint failed: ${minted.stderr ?? ""}`);
	const token = minted.stdout.trim().split(/\s+/)[1];
	if (!token) throw new Error(`egress --mint printed no token: ${JSON.stringify(minted.stdout)}`);
	// 0600: the token is the whole authority of the control surface, and runDir
	// is readable from inside the sandbox.
	writeFileSync(tokensPath, `${session} ${token}\n`, { mode: 0o600 });

	const logFile = createWriteStream(logPath);
	// "none" rather than omitting --listen: the flag's default is a real port, so
	// leaving it out would open TCP on a run that asked for the socket only.
	const proc = spawn(
		bin,
		[
			"--listen", listen === "unix" ? "none" : "127.0.0.1:0",
			...(socketPath ? ["--listen-unix", socketPath] : []),
			"--addr-file", addrPath, "--config", configPath,
			"--tokens", tokensPath, "--audit", auditPath,
		],
		{ cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	proc.stdout.pipe(logFile);
	proc.stderr.pipe(logFile);

	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		process.off("exit", stop);
		if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
		// SIGKILL is deliberate (a proxy that ignores SIGTERM must still die) and it
		// means the socket file is never unlinked by the proxy itself. The next run in
		// this directory recovers from that — listenUnixSocket asks the socket before
		// removing it — but leaving debris behind would make every re-run's log carry
		// a stale-socket line for a condition we created.
		if (socketPath) rmSync(socketPath, { force: true });
	};
	// A proxy left running holds a port and a spawn directory belonging to a run
	// that is over. This harness has been burned by orphans before, so reap it on
	// every way out of the parent, not only the tidy one.
	process.on("exit", stop);

	// Poll for the announced address. Bounded, and it gives up as soon as the
	// process is gone rather than waiting out the timeout on a proxy that
	// refused its own config — the log holds the reason.
	const deadline = Date.now() + waitMs;
	let addr = "";
	while (Date.now() < deadline) {
		if (existsSync(addrPath)) {
			addr = readFileSync(addrPath, "utf8").trim();
			if (addr) break;
		}
		if (proc.exitCode !== null) {
			stop();
			const why = existsSync(logPath) ? readFileSync(logPath, "utf8").trim() : "(no log)";
			throw new Error(`egress proxy exited before listening (code ${proc.exitCode}):\n${why}`);
		}
		sleepSync(50);
	}
	if (!addr) {
		stop();
		throw new Error(`egress proxy did not announce an address within ${waitMs}ms`);
	}

	// `url` is the address a SANDBOXED client should use, which is why the socket
	// wins whenever there is one: with both doors open, handing the kernel the TCP
	// address would hand it the door that does not work on Linux, and it would fail
	// as silence — a spawn that never happened. `httpUrl` stays available for clients
	// that can only speak TCP (an MCP SDK pointed at {proxy}/r/<route>).
	const httpUrl = addr.startsWith("unix:") ? null : `http://${addr}`;
	const unixUrl = socketPath ? `unix:${socketPath}` : null;
	return {
		url: unixUrl ?? httpUrl,
		...(httpUrl ? { httpUrl } : {}),
		...(unixUrl ? { unixUrl, socketPath } : {}),
		token, auditPath, configPath, logPath, stop, pid: proc.pid,
	};
}

/**
 * The audit log as records. Used by task checks to assert that traffic really
 * crossed the boundary — the point of §"Log the inputs, not just the verdicts"
 * is that a verdict without its evidence cannot be re-derived, and this is the
 * evidence.
 */
export function readEgressAudit(auditPath) {
	if (!existsSync(auditPath)) return [];
	return readFileSync(auditPath, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}
