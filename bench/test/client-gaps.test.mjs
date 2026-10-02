/**
 * Three gaps in the generated client, driven in real Python against a stub proxy
 * that records every request:
 *
 *  - `wait_for(result)` on a record that carries a JOB ref, not an asset, handed the
 *    record itself to json.dumps and died with a TypeError. Job refs (either
 *    spelling), `job_id` records and mixed lists now route to the `/wait` body's
 *    `jobs`, and anything else is an error that names what wait_for takes.
 *  - an ArgumentError named the server's package (`api.maker.echo`) when the function
 *    lives in a category module (`api.session.echo`) — a call the cell never made.
 *  - a failed id came back from `/wait` as "already ready", and the model reported
 *    it as done. A `failed` list in the reply now raises, and wins over pending ids.
 *  - only `/call` carried `x-egress-token`, so a bridge could authenticate nothing
 *    else. Every route the client uses now does.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DEFAULT_BRIDGE_HEADER, generate } from "../generate.mjs";
import { PRODUCT_PORT_OPTIONS } from "../generator-presets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(ROOT, "bench/test/fixtures/client_gaps_probe.py");
const KERNEL_PY = join(homedir(), ".prime/agent/kernel-venv/bin/python");
const PYTHON = existsSync(KERNEL_PY) ? KERNEL_PY : "python3";

const output = (title, properties) => ({ title, type: "object", properties, required: Object.keys(properties) });
const tool = (name, category, outputSchema, extra = {}) => ({
	name,
	category,
	description: `${name.replace(/_/g, " ")}.`,
	inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
	outputSchema,
	...extra,
});

const CATALOGUE = [
	{
		server: "maker",
		tools: [
			{
				...tool("echo", "session", output("EchoOutput", { text: { type: "string" } })),
				inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			},
			tool("make_image", "session", output("MakeImageOutput", { asset_id: { type: "string", format: "product-ref", "x-ref-kinds": ["image"] } })),
			tool("start_job", "jobs", output("StartJobOutput", { job_id: { type: "string", format: "product-ref", "x-ref-kinds": ["job"] } })),
			tool("legacy_job", "jobs", output("LegacyJobOutput", { job: { type: "string", format: "product-job-ref" } })),
			tool("judge_tool", "jobs", output("JudgeOutput", { verdict: { type: "string" } }), { launches: true }),
		],
	},
];

const OPTIONS = { ...PRODUCT_PORT_OPTIONS, apiLayout: "consolidated", typedReturns: true, validateArgs: true, allowUntyped: true };

describe("generated client: wait_for job refs, call-path errors, egress token on every route", () => {
	const dirs = [];
	let probe;
	before(() => {
		const dir = mkdtempSync(join(tmpdir(), "harness-client-gaps-"));
		dirs.push(dir);
		for (const [rel, content] of Object.entries(generate(CATALOGUE, OPTIONS).files)) {
			const path = join(dir, "api", rel);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		// The last line: wait_for prints its "already ready" notice before it.
		probe = JSON.parse(execFileSync(PYTHON, [PROBE, dir], { encoding: "utf8" }).trim().split("\n").at(-1));
	});
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	const waits = () => probe.requests.filter((r) => r.path === "/wait").map((r) => ({ assets: r.body.assets, jobs: r.body.jobs }));

	it("waits on a record's job ref, in the x-ref-kinds and the legacy format spelling", () => {
		assert.equal(probe.outcomes.wait_job_record, "ok");
		assert.equal(probe.outcomes.wait_legacy_job_record, "ok");
		assert.deepEqual(waits()[0], { assets: [], jobs: ["job_ref_1"] });
		assert.deepEqual(waits()[1], { assets: [], jobs: ["job_ref_legacy"] });
	});

	it("waits on a plain dict's job_id", () => {
		assert.equal(probe.outcomes.wait_job_id_dict, "ok");
		assert.deepEqual(waits()[2], { assets: [], jobs: ["job_dict_1"] });
	});

	it("splits a mixed list into assets and jobs", () => {
		assert.equal(probe.outcomes.wait_mixed_list, "ok");
		assert.deepEqual(waits()[3], { assets: ["img_1", "img_bare"], jobs: ["job_ref_1", "job_dict_2"] });
	});

	it("rejects an unrecognised value with a message naming what wait_for takes, and sends nothing", () => {
		assert.match(probe.outcomes.wait_unrecognised, /^ArgumentError: wait_for takes asset ids, job ids/);
		assert.match(probe.outcomes.wait_unrecognised, /got int: 42/);
		assert.equal(waits().filter((w) => !w.assets.includes("img_failed")).length, 4);
	});

	it("raises on a failed id, naming it and its reason, and never says it is ready", () => {
		assert.match(probe.outcomes.wait_failed, /^McpError: wait_for: failed — img_failed: upstream auth failed\. It produced nothing/);
		assert.match(probe.outcomes.wait_failed, /do not read it or report it as done/);
		assert.deepEqual(waits()[4], { assets: ["img_failed"], jobs: [] });
	});

	it("raises on failure even while other ids are still pending, rather than ending the cell to wait", () => {
		assert.match(probe.outcomes.wait_failed_and_pending, /^McpError: wait_for: failed — img_failed: upstream auth failed\./);
		assert.doesNotMatch(probe.outcomes.wait_failed_and_pending, /WaitSignal|img_pending/);
	});

	it("names the category module the function lives in, not the server's package", () => {
		assert.match(probe.outcomes.argument_error, /^ArgumentError: api\.session\.echo: /);
	});

	it("sends x-egress-token on /call, /wait, /spawn and /job", () => {
		const routes = new Set(probe.requests.map((r) => (r.path.startsWith("/job/") ? "/job" : r.path)));
		assert.deepEqual([...routes].sort(), ["/call", "/job", "/spawn", "/wait"]);
		for (const r of probe.requests) assert.equal(r.headers["x-egress-token"], "tok-123", `${r.method} ${r.path} carried no token`);
	});

	it("keeps the caller header on /call and /spawn only", () => {
		const header = PRODUCT_PORT_OPTIONS.bridgeHeader ?? DEFAULT_BRIDGE_HEADER;
		for (const r of probe.requests) {
			const tagged = r.path === "/call" || r.path === "/spawn";
			assert.equal(r.headers[header], tagged ? "api/_client" : undefined, `${r.method} ${r.path}`);
		}
	});
});
