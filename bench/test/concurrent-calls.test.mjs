/**
 * `_client.call` is a coroutine, and `asyncio.gather` over API calls is the
 * efficiency lever the prompts teach — so the network round trip must not block
 * the event loop. It did: the urlopen ran inline, and every gathered call ran one
 * after another. Driven in real Python against a stub proxy that holds each call.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { generate } from "../generate.mjs";
import { PRODUCT_PORT_OPTIONS } from "../generator-presets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(ROOT, "bench/test/fixtures/concurrent_calls_probe.py");
const CATALOGUE = [
	{
		server: "svc",
		tools: [{ name: "make_thing", description: "make_thing.", inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } }],
	},
];
const N = 5;
const DELAY_S = 0.3;

describe("gathered calls run concurrently", () => {
	const dirs = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	const cases = {
		default: {},
		"typed returns + validation + wait surface": { typedReturns: true, validateArgs: true, waitSurface: true },
		PRODUCT_PORT_OPTIONS,
	};
	for (const [label, options] of Object.entries(cases)) {
		it(`${N} calls held ${DELAY_S}s each finish in about one hold (${label})`, () => {
			const dir = mkdtempSync(join(tmpdir(), "harness-concurrent-"));
			dirs.push(dir);
			for (const [rel, content] of Object.entries(generate(CATALOGUE, options).files)) {
				const path = join(dir, "api", rel);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content);
			}
			const [calls, elapsed, peak] = execFileSync("python3", [PROBE, dir, String(N), String(DELAY_S)], { encoding: "utf8" }).trim().split(" ").map(Number);
			assert.equal(calls, N);
			assert.equal(peak, N, `only ${peak} of ${N} calls were ever in flight at once`);
			assert.ok(elapsed < DELAY_S * 3, `${N} gathered calls took ${elapsed}s; serial would be ${N * DELAY_S}s`);
		});
	}
});
