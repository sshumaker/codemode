/**
 * Base64 fields in an outputSchema, and the class-extension hook.
 *
 * A string the schema marks as bytes (`contentEncoding: "base64"`, OpenAPI's
 * `format: "byte"` / `"binary"`) gets a decoded accessor, and its class prints the
 * field's size instead of its text. A catalogue with no such field must render the
 * `_types.py` it always did.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { generate } from "../generate.mjs";

const KERNEL_PY = join(homedir(), ".prime/agent/kernel-venv/bin/python");
const PYTHON = existsSync(KERNEL_PY) ? KERNEL_PY : "python3";

const tool = (name, outputSchema) => ({
	name,
	description: `${name}.`,
	inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
	outputSchema,
});

/** pydantic's rendering of an Optional field with `json_schema_extra={"contentEncoding": "base64"}`. */
const SESSION_FILE = {
	title: "SessionFile",
	type: "object",
	additionalProperties: false,
	required: ["mime_type", "size"],
	properties: {
		name: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
		mime_type: { type: "string" },
		size: { type: "integer" },
		text: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
		data_b64: { anyOf: [{ type: "string" }, { type: "null" }], default: null, contentEncoding: "base64", description: "The raw bytes." },
	},
};

const TWO = {
	title: "PairOutput",
	type: "object",
	additionalProperties: false,
	properties: {
		front: { type: "string", format: "byte" },
		back_base64: { type: "string", contentEncoding: "base64url" },
	},
};

const CLASHING = {
	title: "ClashOutput",
	type: "object",
	additionalProperties: false,
	properties: { blob: { type: "string", format: "binary" }, blob_bytes: { type: "integer" }, bytes: { type: "integer" } },
};

const PLAIN = { title: "PlainOutput", type: "object", additionalProperties: false, properties: { text: { type: "string" } } };

const catalogue = (...tools) => [{ server: "svc", tools }];

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function runPython(files, script) {
	const dir = mkdtempSync(join(tmpdir(), "harness-binary-"));
	dirs.push(dir);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, "api", rel)), { recursive: true });
		writeFileSync(join(dir, "api", rel), text);
	}
	return execFileSync(PYTHON, ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(dir)})\n${script}`], { encoding: "utf8" }).trim();
}

describe("a base64 field", () => {
	it("is absent from a catalogue that has none: no helpers, no import", () => {
		const types = generate(catalogue(tool("plain", PLAIN)), { typedReturns: true }).files["_types.py"];
		assert.doesNotMatch(types, /import base64|_decode_binary|_BINARY_FIELDS/);
	});

	it("is documented in the class with the accessor that decodes it", () => {
		const types = generate(catalogue(tool("read", SESSION_FILE)), { typedReturns: true }).files["_types.py"];
		assert.match(types, /^ {4}data_b64: \[base64; decoded as \.data_bytes\] The raw bytes\.$/m);
		assert.match(types, /^ {4}def data_bytes\(self\) -> bytes \| None:$/m);
		assert.match(types, /^ {4}def bytes\(self\) -> bytes \| None:$/m);
	});

	it("decodes in real Python, and prints its size rather than its text", () => {
		const files = generate(catalogue(tool("read", SESSION_FILE)), { typedReturns: true, apiLayout: "consolidated" }).files;
		const out = runPython(
			files,
			`
import base64, json
import api._types as T, api.svc
data = bytes(range(256)) * 40
r = T.wrap(json.dumps({"mime_type": "image/png", "size": len(data), "data_b64": base64.b64encode(data).decode()}), "SessionFile")
assert r.data_bytes == data and r.bytes == data
assert base64.b64encode(data).decode()[:40] not in str(r) + repr(r), "the payload leaked into print()"
assert repr(r) == "SessionFile(mime_type='image/png', size=10240, data_b64=<10240 bytes>)", repr(r)
assert json.loads(str(r)) == {"mime_type": "image/png", "size": 10240, "data_b64": "<10240 bytes>"}, str(r)
assert r.raw["data_b64"] == base64.b64encode(data).decode(), "raw keeps the payload"
t = T.wrap(json.dumps({"mime_type": "text/plain", "size": 2, "text": "hi"}), "SessionFile")
assert t.bytes is None and t.data_bytes is None and repr(t) == "SessionFile(mime_type='text/plain', size=2, text='hi')"
print("ok")
`,
		);
		assert.equal(out, "ok");
	});

	it("names one accessor per field, keeps .bytes for a class with one payload, and never shadows a field", () => {
		const files = generate(catalogue(tool("pair", TWO), tool("clash", CLASHING)), { typedReturns: true }).files;
		const out = runPython(
			files,
			`
import base64, json
import api._types as T
p = T.wrap(json.dumps({"front": base64.b64encode(b"ab").decode(), "back_base64": base64.urlsafe_b64encode(b"\\xfb\\xff").decode().rstrip("=")}), "PairOutput")
assert p.front_bytes == b"ab" and p.back_bytes == b"\\xfb\\xff"
assert not isinstance(type(p).__dict__.get("bytes"), property), "two payloads: no single .bytes"
c = T.wrap(json.dumps({"blob": base64.b64encode(b"xyz").decode(), "blob_bytes": 3, "bytes": 3}), "ClashOutput")
assert c.blob_bytes == 3 and c.bytes == 3, "a payload field keeps its own name"
assert repr(c) == "ClashOutput(blob=<3 bytes>, blob_bytes=3, bytes=3)", repr(c)
print("ok")
`,
		);
		assert.equal(out, "ok");
	});
});

describe("classExtensions", () => {
	// What the product's port appends to SessionFile today by monkey-patch.
	const SESSION_FILE_EXTENSION = `
@property
def bytes(self) -> bytes:
    """The asset's raw bytes: decoded from the payload, or the text as UTF-8."""
    if self.data_b64 is not None:
        return self.data_bytes
    return (self.text or "").encode("utf-8")
`;

	it("appends members to the named class, after (so over) the generated ones", () => {
		const files = generate(catalogue(tool("read", SESSION_FILE)), { typedReturns: true, classExtensions: { SessionFile: SESSION_FILE_EXTENSION, Missing: "x = 1" } }).files;
		assert.doesNotMatch(files["_types.py"], /^ {4}x = 1$/m, "a class this catalogue does not generate is skipped");
		const out = runPython(
			files,
			`
import json
import api._types as T
t = T.wrap(json.dumps({"mime_type": "text/plain", "size": 2, "text": "hi"}), "SessionFile")
assert t.bytes == b"hi", t.bytes
print("ok")
`,
		);
		assert.equal(out, "ok");
	});

	it("accepts a list of lines, and leaves the tree untouched when unset", () => {
		const base = generate(catalogue(tool("plain", PLAIN)), { typedReturns: true }).files["_types.py"];
		const extended = generate(catalogue(tool("plain", PLAIN)), { typedReturns: true, classExtensions: { PlainOutput: ["def shout(self) -> str:", "    return (self.text or '').upper()"] } }).files["_types.py"];
		assert.equal(generate(catalogue(tool("plain", PLAIN)), { typedReturns: true, classExtensions: {} }).files["_types.py"], base);
		assert.match(extended, /^ {4}def shout\(self\) -> str:\n {8}return \(self\.text or ''\)\.upper\(\)$/m);
		assert.equal(runPython({ "_types.py": extended, "__init__.py": "" }, `import json, api._types as T; print(T.wrap(json.dumps({"text": "hi"}), "PlainOutput").shout())`), "HI");
	});
});
