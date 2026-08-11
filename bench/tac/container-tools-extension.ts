/**
 * The vanilla arm's tool surface for TheAgentCompany: conventional JSON tools,
 * each executing inside the task container.
 *
 * prime's own bash/read/write tools run on the host, which is the wrong machine
 * — the workspace, the seeded services and the grader all live in the container.
 * Registering container-scoped equivalents through the extension API keeps the
 * two arms differing in exactly one respect, which is the whole point: vanilla
 * calls discrete tools, codemode writes code into a persistent REPL. Both reach
 * the same filesystem and the same services.
 *
 * The tool set mirrors what a mainstream harness ships (shell, read, write,
 * targeted edit) rather than the minimum that would pass these tasks. An arm
 * built weaker than the harnesses it stands in for would flatter codemode.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);

const CONTAINER = process.env.HARNESS_EXEC_CONTAINER ?? "";
/** Cells and commands can hang on a wedged service; bound them like the REPL is bounded. */
const TIMEOUT_MS = Number(process.env.HARNESS_TAC_TOOL_TIMEOUT_MS ?? 300_000);
const MAX_OUTPUT = 40_000;

function clip(text: string): string {
	if (text.length <= MAX_OUTPUT) return text;
	const half = MAX_OUTPUT / 2;
	return `${text.slice(0, half)}\n… [${text.length - MAX_OUTPUT} chars elided] …\n${text.slice(-half)}`;
}

/**
 * Run a command in the container. Non-zero exit is returned as text rather than
 * thrown: a failing command is information the model should act on, and the
 * built-in bash tool behaves the same way.
 */
async function sh(command: string): Promise<string> {
	try {
		const { stdout, stderr } = await run("docker", ["exec", CONTAINER, "bash", "-lc", command], {
			timeout: TIMEOUT_MS,
			maxBuffer: 64 * 1024 * 1024,
		});
		return clip(stdout + (stderr ? `\n${stderr}` : ""));
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
		if (e.killed) return `Command timed out after ${TIMEOUT_MS / 1000}s`;
		return clip(`${e.stdout ?? ""}${e.stderr ?? ""}\n[exit ${e.code ?? "?"}]`);
	}
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

/** Pass file contents through a heredoc-free path so quoting never corrupts them. */
async function writeFile(path: string, contents: string): Promise<string> {
	const b64 = Buffer.from(contents, "utf8").toString("base64");
	return sh(`mkdir -p "$(dirname ${JSON.stringify(path)})" && echo ${b64} | base64 -d > ${JSON.stringify(path)}`);
}

export default function (pi: ExtensionAPI) {
	if (!CONTAINER) throw new Error("HARNESS_EXEC_CONTAINER is required for the TheAgentCompany vanilla arm");

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the work environment. Use this to run scripts, inspect files, call HTTP APIs with curl, and interact with the company's services.",
		parameters: {
			type: "object",
			properties: { command: { type: "string", description: "The bash command to execute." } },
			required: ["command"],
		} as never,
		execute: async (_id: string, params: unknown) => text(await sh((params as { command: string }).command)),
	});

	pi.registerTool({
		name: "read_file",
		label: "read_file",
		description: "Read the contents of a file at the given absolute path.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Absolute path of the file to read." } },
			required: ["path"],
		} as never,
		execute: async (_id: string, params: unknown) =>
			text(await sh(`cat ${JSON.stringify((params as { path: string }).path)}`)),
	});

	pi.registerTool({
		name: "write_file",
		label: "write_file",
		description: "Write contents to a file at the given absolute path, creating parent directories as needed. Overwrites any existing file.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path of the file to write." },
				contents: { type: "string", description: "Full contents to write." },
			},
			required: ["path", "contents"],
		} as never,
		execute: async (_id: string, params: unknown) => {
			const p = params as { path: string; contents: string };
			await writeFile(p.path, p.contents);
			return text(`Wrote ${p.contents.length} bytes to ${p.path}`);
		},
	});

	pi.registerTool({
		name: "str_replace",
		label: "str_replace",
		description:
			"Replace an exact string in a file with new text. The old string must appear exactly once in the file.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path of the file to edit." },
				old_str: { type: "string", description: "Exact text to replace; must be unique in the file." },
				new_str: { type: "string", description: "Replacement text." },
			},
			required: ["path", "old_str", "new_str"],
		} as never,
		execute: async (_id: string, params: unknown) => {
			const p = params as { path: string; old_str: string; new_str: string };
			// Done in Python rather than sed so the match is literal — task files
			// contain regex metacharacters, and a silent mis-edit is worse than a
			// refusal.
			const script = `
import json, sys
p, old, new = json.loads(sys.stdin.read())
s = open(p).read()
n = s.count(old)
if n != 1:
    print(f"Error: old_str appears {n} times in {p}; it must appear exactly once.")
else:
    open(p, "w").write(s.replace(old, new))
    print(f"Edited {p}")
`;
			const payload = Buffer.from(JSON.stringify([p.path, p.old_str, p.new_str]), "utf8").toString("base64");
			const b64script = Buffer.from(script, "utf8").toString("base64");
			return text(
				await sh(`echo ${b64script} | base64 -d > /tmp/.str_replace.py && echo ${payload} | base64 -d | python_default /tmp/.str_replace.py`),
			);
		},
	});
}
