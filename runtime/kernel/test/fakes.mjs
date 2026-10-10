/** Stand-ins for runtime/daytona/provider.mjs, and a conversation context, for the kernel backend tests. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function connectionInfo(over = {}) {
	return {
		sandboxId: "sb-1",
		url: "wss://8765-sb-1.daytonaproxy01.net",
		token: "server-token",
		headers: { "x-daytona-preview-token": "preview" },
		remoteCwd: "/home/daytona/work",
		mounts: [],
		posture: { boundary: "daytona-sandbox", egress: "blocked" },
		created: true,
		timings: {},
		...over,
	};
}

/** As the provider resolves them: a relative remote is under the work dir. */
const resolveMounts = (mounts = []) =>
	mounts.map((m) => ({ local: m.local, remote: m.remote.startsWith("/") ? m.remote : `/home/daytona/work/${m.remote}` }));

/**
 * A provider module whose DaytonaKernelProvider constructor hands back one shared fake
 * provider, recording calls, uploads and the options each provider was built with.
 */
export function fakeModule(opts = {}) {
	const calls = [];
	const files = new Map();
	const uploads = [];
	const constructed = [];
	const info = connectionInfo({ created: opts.created ?? true });
	let released = 0;
	let ensureGate;
	let ensureError;
	const provider = {
		ensure: async (id, o) => {
			calls.push({ op: "ensure", args: [id, o] });
			if (ensureGate) await ensureGate;
			if (ensureError) throw ensureError;
			return { ...info, mounts: resolveMounts(o?.mounts) };
		},
		stop: async (id) => void calls.push({ op: "stop", args: [id] }),
		destroy: async (id) => void calls.push({ op: "destroy", args: [id] }),
		keepAlive: (id) => {
			calls.push({ op: "keepAlive", args: [id] });
			return () => {
				released++;
			};
		},
		uploadFile: async (id, path, data) => {
			files.set(path, data);
			uploads.push({ id, path, bytes: data.toString() });
			return `/home/daytona/work/${path}`;
		},
		listTree: async () => [{ path: "outputs/a.csv", size: 3, mtimeMs: 1 }],
		readFile: async (_id, path) => files.get(path) ?? Buffer.from("remote bytes"),
		close: async () => void calls.push({ op: "close", args: [] }),
		...(opts.orphans ? { find: async () => undefined, listOrphans: async () => opts.orphans } : {}),
	};
	const mod = {
		DaytonaKernelProvider: class {
			constructor(o) {
				constructed.push(o);
				// biome-ignore lint/correctness/noConstructorReturn: a stand-in hands back the shared fake
				return provider;
			}
		},
		connectionEnv: (i) => ({
			HARNESS_REMOTE_KERNEL_URL: i.url,
			HARNESS_REMOTE_KERNEL_TOKEN: i.token,
			HARNESS_REMOTE_KERNEL_HEADERS: JSON.stringify(i.headers),
			HARNESS_REMOTE_KERNEL_CWD: i.remoteCwd,
			HARNESS_REMOTE_KERNEL_PATH_MAP: JSON.stringify(i.mounts),
		}),
		connectFileContents: (i) => `${JSON.stringify({ url: i.url, token: i.token, headers: i.headers })}\n`,
	};
	return {
		mod,
		provider,
		calls,
		files,
		uploads,
		constructed,
		released: () => released,
		gateEnsure: (p) => (ensureGate = p),
		failEnsure: (e) => (ensureError = e),
	};
}

export function kernelContext(over = {}) {
	const convDir = mkdtempSync(join(tmpdir(), "hk-kb-"));
	return {
		conversationId: "conv-1",
		userId: "u",
		convDir,
		workDir: join(convDir, "work"),
		apiTreeDir: "/data/api-tree",
		skillRoots: ["/repo/tools/skills"],
		tmpDir: "/tmp/hk-x",
		agentBinDir: "/data/agent-bin",
		egressToken: "egress-conv-1",
		toolProxyPath: "/tool-proxy",
		localBaseUrl: "http://127.0.0.1:8787",
		...over,
	};
}
