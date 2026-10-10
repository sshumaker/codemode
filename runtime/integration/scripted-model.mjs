/**
 * A deterministic, scripted stand-in for a model API: an OpenAI-compatible
 * `/chat/completions` endpoint (streaming) that replays a script of assistant turns.
 *
 * prime reaches it the way it reaches any self-hosted model — a custom provider in the
 * agent home's models.json (`modelsJson()` below) — so a full agent turn runs through
 * prime's real provider, loop, tools and session persistence with no API key, no
 * network and no cost. Nothing in prime is patched for it.
 *
 * A script is a JSON file (or object): `{ "turns": [turn, ...] }`, one turn per model
 * request, served in order across every prime process that talks to this server — a
 * session's turns survive the process exiting at a wait and the scheduler starting a
 * fresh `prime -c`. A turn is:
 *
 *   text      assistant text (optional)
 *   ipython   code for one `ipython` tool call (shorthand for tools: [{name, args}])
 *   tools     [{ name, args }] — several tool calls in one response
 *   expect    a regex the request's LAST message (user or tool result) must match;
 *             a mismatch is recorded and answered with text, never a tool call
 *   hold      a label: the response is withheld until the test calls release(label)
 *             (or the client disconnects) — how a test keeps prime mid-turn
 *
 * `{{NAME}}` in any string is replaced from `vars` when the server starts.
 *
 * Every request is recorded (requests.jsonl in `dir`, and `.requests` in memory) with
 * the full message list the "model" was shown — so a test asserts on what the agent
 * actually saw in its next turn's input, not only on what ended up on disk.
 *
 * CLI (manual use): node scripted-model.mjs <script.json> [--port N] [--dir D]
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PROVIDER = "scripted";
export const MODEL_ID = "scripted-1";
export const MODEL = `${PROVIDER}/${MODEL_ID}`;

const substitute = (value, vars) => {
	if (typeof value === "string") return value.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
	if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
	}
	return value;
};

/** The text of one OpenAI-format message (string content or content parts). */
export function messageText(m) {
	if (!m) return "";
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) return m.content.map((p) => p.text ?? "").join("");
	return "";
}

/** The models.json that registers this server as prime's `scripted` provider. */
export function modelsJson(baseUrl) {
	return {
		providers: {
			[PROVIDER]: {
				baseUrl,
				apiKey: "scripted-no-key",
				api: "openai-completions",
				models: [
					{
						id: MODEL_ID,
						name: "Scripted (integration tests)",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200000,
						maxTokens: 8192,
					},
				],
			},
		},
	};
}

function normalizeTurn(turn, i) {
	const tools = [...(turn.tools ?? [])];
	if (turn.ipython !== undefined) tools.push({ name: "ipython", args: { code: turn.ipython } });
	return { ...turn, tools: tools.map((t, j) => ({ id: t.id ?? `call_${i + 1}_${j + 1}`, ...t })) };
}

function chunk(id, delta, finish = null, usage = undefined) {
	return {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: MODEL_ID,
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(usage ? { usage } : {}),
	};
}

function streamTurn(res, turn, n) {
	const id = `scripted-${n}`;
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
	send(chunk(id, { role: "assistant", content: "" }));
	if (turn.text) send(chunk(id, { content: turn.text }));
	turn.tools.forEach((t, index) => {
		send(chunk(id, { tool_calls: [{ index, id: t.id, type: "function", function: { name: t.name, arguments: "" } }] }));
		send(chunk(id, { tool_calls: [{ index, function: { arguments: JSON.stringify(t.args ?? {}) } }] }));
	});
	send(chunk(id, {}, turn.tools.length ? "tool_calls" : "stop"));
	send({ ...chunk(id, {}, null), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	res.write("data: [DONE]\n\n");
	res.end();
}

/**
 * Start the server. `script` is a path or `{turns}`; `dir` (optional) receives
 * requests.jsonl. Returns { baseUrl, requests, errors, release(label), waitForRequest,
 * served(), remaining(), close() }.
 */
export async function startScriptedModel({ script, vars = {}, dir, port = 0 } = {}) {
	const raw = typeof script === "string" ? JSON.parse(readFileSync(script, "utf8")) : script;
	const turns = substitute(raw.turns ?? [], vars).map(normalizeTurn);
	const requests = [];
	const errors = [];
	const holds = new Map();
	const waiters = [];
	let cursor = 0;
	if (dir) mkdirSync(dir, { recursive: true });
	const record = (entry) => {
		requests.push(entry);
		if (dir) appendFileSync(join(dir, "requests.jsonl"), `${JSON.stringify(entry)}\n`);
		for (const w of [...waiters]) {
			if (w.pred(entry)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(entry);
			}
		}
	};
	const fail = (res, n, message) => {
		errors.push(message);
		if (dir) writeFileSync(join(dir, "errors.json"), JSON.stringify(errors, null, 2));
		streamTurn(res, { text: `SCRIPT ERROR: ${message}`, tools: [] }, n);
	};

	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => {
			body += d;
		});
		req.on("end", () => {
			if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				res.writeHead(400).end();
				return;
			}
			const messages = parsed.messages ?? [];
			const last = messages.at(-1);
			const n = cursor;
			const turn = turns[cursor];
			const entry = {
				n,
				at: Date.now(),
				lastRole: last?.role,
				last: messageText(last),
				messages,
				tools: (parsed.tools ?? []).map((t) => t.function?.name),
			};
			record(entry);
			if (!turn) {
				fail(res, n, `script exhausted at request ${n + 1} (last message: ${entry.last.slice(0, 200)})`);
				return;
			}
			cursor += 1;
			if (turn.expect && !new RegExp(turn.expect, "s").test(entry.last)) {
				fail(res, n, `turn ${n + 1} expected /${turn.expect}/ in the last message, got: ${entry.last.slice(0, 400)}`);
				return;
			}
			if (turn.hold) {
				const pending = { res, turn, n, released: false };
				holds.set(turn.hold, pending);
				res.on("close", () => {
					if (!pending.released) holds.delete(turn.hold);
				});
				return;
			}
			streamTurn(res, turn, n);
		});
	});
	await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	return {
		baseUrl,
		requests,
		errors,
		turns,
		served: () => cursor,
		remaining: () => turns.length - cursor,
		isHeld: (label) => holds.has(label),
		release(label) {
			const h = holds.get(label);
			if (!h) return false;
			h.released = true;
			holds.delete(label);
			if (!h.res.destroyed) streamTurn(h.res, h.turn, h.n);
			return true;
		},
		/** Resolves with the first request (already recorded or future) matching pred. */
		waitForRequest(pred = () => true, { timeoutMs = 60_000 } = {}) {
			const hit = requests.find(pred);
			if (hit) return Promise.resolve(hit);
			return new Promise((resolve, reject) => {
				const w = { pred, resolve };
				waiters.push(w);
				setTimeout(() => {
					const i = waiters.indexOf(w);
					if (i >= 0) {
						waiters.splice(i, 1);
						reject(new Error(`no model request matched within ${timeoutMs}ms (${requests.length} seen)`));
					}
				}, timeoutMs).unref();
			});
		},
		close: () =>
			new Promise((resolve) => {
				for (const h of holds.values()) h.res.destroy();
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const opt = (name) => {
		const i = args.indexOf(`--${name}`);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
	if (!file) {
		console.error("usage: node scripted-model.mjs <script.json> [--port N] [--dir D]");
		process.exit(2);
	}
	const m = await startScriptedModel({ script: file, port: Number(opt("port") ?? 0), dir: opt("dir") });
	console.log(JSON.stringify({ baseUrl: m.baseUrl, models: modelsJson(m.baseUrl) }, null, 2));
}
