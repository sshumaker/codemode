import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DaytonaKernelBackend } from "../daytona.mjs";
import { fakeModule, kernelContext as ctx } from "./fakes.mjs";

describe("daytona kernel backend", () => {
	test("prime gets the remote kernel, the proxy stays on loopback, the token stays here", async () => {
		const fake = fakeModule();
		const backend = new DaytonaKernelBackend({ providerModule: fake.mod });
		const c = ctx();
		const session = await backend.open(c);
		await session.ready;
		const ensure = fake.calls.find((x) => x.op === "ensure");
		const mounts = ensure?.args[1].mounts;
		assert.deepEqual(mounts.slice(0, 2), [
			{ local: "/data/api-tree", remote: "api" },
			{ local: "/repo/tools/skills", remote: "/home/daytona/skills/0-skills" },
		]);
		assert.equal(mounts[2]?.remote, "/home/daytona/.ipython/profile_default/startup");

		const env = session.primeEnv;
		assert.equal(env.HARNESS_REMOTE_KERNEL_CWD, "/home/daytona/work");
		assert.deepEqual(JSON.parse(env.HARNESS_REMOTE_KERNEL_PATH_MAP)[0], {
			local: "/data/api-tree",
			remote: "/home/daytona/work/api",
		});
		assert.equal(env.HARNESS_MCP_PROXY, "http://127.0.0.1:8787/tool-proxy");
		assert.equal(env.HARNESS_EGRESS_TOKEN, "egress-conv-1");
		assert.equal(env.HARNESS_KERNEL_AUTORESTART, "1");
		assert.equal(env.HARNESS_REMOTE_KERNEL_TOKEN, undefined, "the server token travels in the connect file only");
		const file = env.HARNESS_REMOTE_KERNEL_CONNECT_FILE;
		assert.equal(JSON.parse(readFileSync(file, "utf8")).token, "server-token");
		assert.equal(JSON.parse(readFileSync(file, "utf8")).url, "wss://8765-sb-1.daytonaproxy01.net");
		assert.equal(statSync(file).mode & 0o077, 0, "connect file is private");
		assert.equal(session.primeCwd, c.workDir);
		assert.ok(fake.calls.some((x) => x.op === "keepAlive"));

		const host = join(c.convDir, "upload.csv");
		writeFileSync(host, "a,b\n");
		await session.putInput("inputs/upload.csv", host);
		assert.equal(fake.files.get("inputs/upload.csv")?.toString(), "a,b\n");
		assert.deepEqual(await session.listOutputs(), [{ path: "outputs/a.csv", size: 3, mtimeMs: 1 }]);
		assert.equal((await session.readOutput("outputs/zz")).toString(), "remote bytes");
		// Workspace files for tools go through the sandbox's file API, not the host work dir.
		assert.deepEqual(session.workDirAliases, ["/home/daytona/work"]);
		assert.equal((await session.files.readFile("outputs/a.csv", 1024)).toString(), "remote bytes");
		await assert.rejects(session.files.readFile("outputs/missing.csv", 1024), /no file at outputs\/missing\.csv/);
		await assert.rejects(session.files.readFile("outputs/a.csv", 2), /the cap is/);
		await session.files.writeFile("outputs/export.pdf", Buffer.from("%PDF"));
		assert.equal(fake.files.get("outputs/export.pdf")?.toString(), "%PDF");

		await session.release();
		assert.equal(fake.released(), 1, "release hands the sandbox to Daytona's auto-stop");
		assert.ok(!fake.calls.some((x) => x.op === "stop"), "no stop that could race the next open()");
		await backend.destroy("conv-1");
		assert.ok(fake.calls.some((x) => x.op === "destroy" && x.args[0] === "conv-1"));
	});

	test("with a warm pool: a new conversation's first open claims a warm sandbox before ensure", async () => {
		const fake = fakeModule();
		const relabels = [];
		const known = new Set();
		const provider = fake.provider;
		const ensure = provider.ensure;
		provider.ensure = async (id, o) => {
			known.add(id);
			return ensure(id, o);
		};
		const relabelled = new Map();
		provider.find = async (id) => {
			if (relabelled.has(id)) return { id: relabelled.get(id) };
			return known.has(id)
				? {
						id: `sb-${id}`,
						setLabels: async (labels) => {
							relabels.push({ id, labels });
							relabelled.set(labels.conversation, `sb-${id}`);
						},
					}
				: undefined;
		};
		provider.listOrphans = async () => [];
		const verified = [];
		provider.verify = async (i) => {
			verified.push(i.sandboxId);
			return { ok: true };
		};
		const binds = [];
		provider.bind = (c, sb) => void binds.push([c, sb]);
		const backend = new DaytonaKernelBackend({ providerModule: fake.mod, poolSize: 1, poolOwner: "t", labels: { env: "test" } });
		const dataDir = mkdtempSync(join(tmpdir(), "hk-kbp-"));
		await backend.start({ apiTreeDir: "/data/api-tree", skillRoots: ["/repo/tools/skills"], dataDir });
		await new Promise((r) => setTimeout(r, 10));
		const poolEnsure = fake.calls.find((c) => c.op === "ensure" && String(c.args[0]).startsWith("pool-"));
		assert.ok(poolEnsure, "the pool warmed a sandbox at start");
		const poolMounts = poolEnsure.args[1].mounts;
		// api, skills, startup hooks (the prelude among them), and the harness runtime it imports
		assert.equal(poolMounts.length, 4, "with the same uploads a conversation gets");
		assert.ok(
			poolMounts.some((m) => m.remote === "/home/daytona/harness-runtime"),
			"the prelude's runtime is uploaded",
		);
		const s1 = await backend.open(ctx());
		await s1.ready;
		assert.equal(relabels.length, 1);
		assert.equal(verified.length, 1, "the claimed sandbox's server was asked, once");
		assert.equal(
			fake.calls.filter((c) => c.op === "ensure" && c.args[0] === "conv-1").length,
			0,
			"a verified claim runs no ensure(): the pool's warm-time connection is the conversation's",
		);
		assert.equal(JSON.parse(readFileSync(s1.primeEnv.HARNESS_REMOTE_KERNEL_CONNECT_FILE, "utf8")).token, "server-token");
		assert.deepEqual(
			relabels[0].labels,
			{ app: "assistant-workspace", env: "test", pool: "claimed", pool_owner: "t", conversation: "conv-1" },
			"Daytona merges labels, so the pool's keys are overwritten, not left behind",
		);
		assert.deepEqual(binds, [["conv-1", `sb-${relabels[0].id}`]], "bound by id: label search lags the relabel");
		// A second open of the same conversation never claims again; it ensures its own sandbox.
		await (await backend.open(ctx())).ready;
		assert.equal(relabels.length, 1);
		assert.equal(fake.calls.filter((c) => c.op === "ensure").at(-1)?.args[0], "conv-1");
		const poolLabels = fake.constructed.find((o) => o.labels.pool === "warm")?.labels;
		assert.deepEqual(poolLabels, { env: "test", pool: "warm", pool_owner: "t" });
		await backend.shutdown();
	});

	test("open returns before the sandbox is ready, with a pending connect file prime waits on", async () => {
		const fake = fakeModule();
		let land;
		fake.gateEnsure(new Promise((r) => (land = r)));
		const backend = new DaytonaKernelBackend({ providerModule: fake.mod });
		const session = await backend.open(ctx());
		const file = session.primeEnv.HARNESS_REMOTE_KERNEL_CONNECT_FILE;
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { pending: true }, "prime can start now; its kernel link waits");
		assert.equal(session.primeEnv.HARNESS_REMOTE_KERNEL_CWD, "/home/daytona/work", "the env prime needs is known up front");
		let listed = false;
		const listing = session.listOutputs().then(() => (listed = true));
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(listed, false, "file operations wait for the sandbox");
		assert.ok(!fake.calls.some((x) => x.op === "keepAlive"), "no keep-alive before there is a sandbox");
		land();
		await session.ready;
		await listing;
		assert.equal(JSON.parse(readFileSync(file, "utf8")).token, "server-token");
		assert.ok(fake.calls.some((x) => x.op === "keepAlive"));
		await session.release();
		assert.equal(fake.released(), 1);
	});

	test("a sandbox that cannot start fails ready and tells prime's waiting connect why", async () => {
		const fake = fakeModule();
		fake.failEnsure(new Error("quota exceeded"));
		const backend = new DaytonaKernelBackend({ providerModule: fake.mod });
		const session = await backend.open(ctx());
		await assert.rejects(session.ready, /quota exceeded/);
		await new Promise((r) => setImmediate(r));
		const file = session.primeEnv.HARNESS_REMOTE_KERNEL_CONNECT_FILE;
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { error: "quota exceeded" });
		assert.equal(await session.restored, 0);
	});

	test("a release before the sandbox lands never starts a keep-alive", async () => {
		const fake = fakeModule();
		let land;
		fake.gateEnsure(new Promise((r) => (land = r)));
		const backend = new DaytonaKernelBackend({ providerModule: fake.mod });
		const session = await backend.open(ctx());
		await session.release();
		land();
		await session.ready;
		assert.ok(!fake.calls.some((x) => x.op === "keepAlive"));
	});

	test("the app's extra startup files are uploaded beside harness's hooks and the prelude", async () => {
		const fake = fakeModule();
		const backend = new DaytonaKernelBackend({
			providerModule: fake.mod,
			extraStartupFiles: { "07-computer-fs.py": "COMPUTER = 1\n" },
		});
		const session = await backend.open(ctx());
		await session.ready;
		const startup = fake.calls.find((x) => x.op === "ensure").args[1].mounts[2];
		const names = readdirSync(startup.local).sort();
		assert.ok(names.includes("07-computer-fs.py"));
		assert.ok(names.includes("00-eperm-correction.py"), "harness's own hooks are there too");
		assert.ok(names.includes("10-harness-prelude.py"), "and the prelude");
		assert.equal(readFileSync(join(startup.local, "07-computer-fs.py"), "utf8"), "COMPUTER = 1\n");
	});

	test("the provider is built with the caller's options under the backend's own labels and lifetimes", async () => {
		const fake = fakeModule();
		const lines = [];
		const backend = new DaytonaKernelBackend({
			providerModule: fake.mod,
			providerOptions: { apiKey: "k", labels: { ignored: "x" } },
			labels: { env: "e" },
			poolOwner: "gw",
			log: { info: (m, f) => lines.push([m, f]), warn() {} },
		});
		await (await backend.open(ctx())).ready;
		const o = fake.constructed[0];
		assert.equal(o.apiKey, "k");
		assert.deepEqual(o.labels, { env: "e", pool_owner: "gw" });
		assert.equal(o.autoStopMinutes, 15);
		assert.equal(o.autoDeleteMinutes, -1, "Daytona's own delete is off unless asked for");
		o.log("provider line");
		assert.deepEqual(lines.at(-1), ["daytona", { line: "provider line" }]);
		assert.ok(lines.some(([m]) => m === "daytona sandbox ready"));
	});
});
