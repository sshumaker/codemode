import { spawn as toolSandboxSpawn } from "child_process";
import { writeFileSync as toolSandboxWriteFileSync } from "node:fs";
import { join as toolSandboxJoin } from "node:path";
import { fileTypeFromBuffer as toolSandboxFileType } from "file-type";

/**
 * W121: the read/grep/find/ls tools execute INSIDE the kernel's sandbox.
 *
 * srt wraps the ipykernel child on the recorded rationale that the node
 * orchestrator "is harness code, not agent code". Activating file tools makes
 * that premise false: their paths are model-chosen, so a `read` of
 * ~/.aws/credentials or another job's run dir would execute in the unsandboxed
 * node process — reopening the credential-leak class the sandbox exists to
 * close structurally (35% of transcripts once carried a leaked key).
 *
 * Mechanism: same binary, same settings file, same argv shape as the kernel
 * launch and the arm's own preflight probe —
 * `srt --settings <settings> <bin> <args>`. The filesystem work runs in a
 * sandboxed child; node only formats what comes back. There is deliberately no
 * node-side path *check* here: a reimplementation of the policy would drift
 * from it, and seatbelt evaluates RESOLVED paths (the bundle-symlink lesson in
 * the arm's settings writer) where a string comparison would not.
 *
 * The child interpreter is the kernel venv python (PRIME_AGENT_KERNEL_PYTHON):
 * already read- and exec-allowed by the settings, because the kernel itself
 * runs on it. The child env is built from HARNESS_KERNEL_ENV_ALLOW — the same
 * allow-list the kernel child is built from — so provider keys stay in node.
 *
 * Known, accepted edge: read's resolveReadPathAsync probes existence host-side
 * before the op runs, so a denied path's existence can be inferred from the
 * error shape; its content cannot be read.
 *
 * OFF (identity passthrough) unless both HARNESS_KERNEL_SANDBOX_BIN and
 * HARNESS_KERNEL_SANDBOX_SETTINGS are set — the same pair the kernel launcher
 * keys on, so tools and cells are governed together or not at all.
 */

// The op and path travel as HARNESS_* ENV, not argv: srt shell-joins the
// command it wraps (the kernel's argv survives only because every token is
// simple), so argv would both mangle a multiline -c program — measured: bash
// executed line 1, `import`, as ImageMagick — and shell-parse a hostile path.
// Env values cross srt verbatim and are never parsed. The script itself is a
// FILE, written host-side into a sandbox-readable dir, because a single token
// is the only argv shape that survives the join.
const TOOL_SANDBOX_OPS_PY = [
	"import json,os,sys",
	"op=os.environ['HARNESS_TOOL_SANDBOX_OP']; p=os.environ['HARNESS_TOOL_SANDBOX_PATH']",
	// A skill dir read mirrors stock's MCP read(ref="skills/<slug>"): SKILL.md
	// content plus a references listing block, in stock's exact wording. The
	// path prefix is derived from the dir path "from skills/ onward", the way
	// stock renders cwd-relative ("skills/<slug>/references/<file>").
	"def _skill_ref_prefix(d):",
	"    parts=[x for x in d.replace(os.sep,'/').split('/') if x!='']",
	"    if 'skills' in parts:",
	"        i=len(parts)-1-parts[::-1].index('skills')",
	"        return '/'.join(parts[i:])",
	"    return os.path.basename(d.rstrip('/'))",
	"def _skill_dir_content(d):",
	"    content=open(os.path.join(d,'SKILL.md'),'r',encoding='utf-8',errors='replace').read()",
	"    refs=os.path.join(d,'references')",
	"    listing=[]",
	"    if os.path.isdir(refs):",
	"        prefix=_skill_ref_prefix(d)",
	"        for root,dirs,files in os.walk(refs):",
	"            for f in files:",
	"                rel=os.path.relpath(os.path.join(root,f),refs).replace(os.sep,'/')",
	"                listing.append(prefix+'/references/'+rel)",
	"    if listing:",
	"        listing.sort()",
	"        content=content+\"\\n\\nThis skill's references, addressable by full path:\\n\"+'\\n'.join('- '+x for x in listing)",
	"    return content",
	// Any other directory READS as its listing (W128). Before this it was EISDIR
	// plus a hint to use ls — a correct hint that still cost the turn. `read api/`
	// and `read skills/` were 0.81 turns per job in W126; the model's path was
	// right and only the verb was wrong, so the verb now does the obvious thing.
	"def _dir_listing(d):",
	"    names=sorted(os.listdir(d))",
	"    rows=[(n+'/' if os.path.isdir(os.path.join(d,n)) else n) for n in names]",
	"    return '['+d+' is a directory with '+str(len(rows))+' entries; read a file by its path]\\n'+'\\n'.join(rows)+('\\n' if rows else '')",
	"try:",
	// read/access of a directory that holds SKILL.md succeeds with stock
	// semantics (the skill body); any other directory reads as its listing. The
	// FS work stays inside the sandbox child; node only formats.
	"    if op=='read':",
	"        if os.path.isdir(p):",
	"            if os.path.isfile(os.path.join(p,'SKILL.md')): sys.stdout.write(_skill_dir_content(p))",
	"            else: sys.stdout.write(_dir_listing(p))",
	"        else: sys.stdout.buffer.write(open(p,'rb').read())",
	"    elif op=='access':",
	"        if not os.path.isdir(p): open(p,'rb').close()",
	// The image sniff read.ts runs BEFORE readFile. Stock's default op opens the
	// path host-side and reads 4100 bytes -- outside the sandbox, and EISDIR on
	// the skill directory the ops above just admitted. A directory sniffs as
	// nothing; a file yields its head for the same file-type detector.
	"    elif op=='sniff':",
	"        if not os.path.isdir(p): sys.stdout.buffer.write(open(p,'rb').read(4100))",
	"    elif op=='readtext': sys.stdout.write(open(p,'r',encoding='utf-8',errors='replace').read())",
	"    elif op=='exists': sys.stdout.write('1' if os.path.exists(p) else '0')",
	"    elif op=='isdir': sys.stdout.write('1' if os.path.isdir(p) else '0')",
	"    elif op=='stat':",
	"        st=os.stat(p); sys.stdout.write(json.dumps({'dir':os.path.isdir(p),'size':st.st_size,'mtimeMs':st.st_mtime*1000}))",
	"    elif op=='readdir': sys.stdout.write(json.dumps(sorted(os.listdir(p))))",
	"    else: sys.stderr.write('unknown op: '+op); sys.exit(64)",
	"except FileNotFoundError: sys.stderr.write('ENOENT'); sys.exit(2)",
	"except IsADirectoryError: sys.stderr.write('EISDIR'); sys.exit(5)",
	"except NotADirectoryError: sys.stderr.write('ENOTDIR'); sys.exit(6)",
	"except PermissionError: sys.stderr.write('EACCES'); sys.exit(3)",
].join("\n");

export function toolSandboxActive(): boolean {
	return Boolean(process.env.HARNESS_KERNEL_SANDBOX_BIN && process.env.HARNESS_KERNEL_SANDBOX_SETTINGS);
}

/** argv for running `bin args` inside the sandbox; identity when inactive. */
export function toolSandboxWrap(bin: string, args: string[]): { bin: string; args: string[] } {
	if (!toolSandboxActive()) return { bin, args };
	const srt = process.env.HARNESS_KERNEL_SANDBOX_BIN as string;
	const settings = process.env.HARNESS_KERNEL_SANDBOX_SETTINGS as string;
	return { bin: srt, args: ["--settings", settings, bin, ...args] };
}

/** The env a sandboxed tool child gets: the kernel child's allow-list, verbatim. */
export function toolSandboxChildEnv(): Record<string, string> {
	// Inactive = upstream behavior, untouched: the scrub exists for sandboxed
	// children only, so an unsandboxed run stays byte-identical to stock.
	if (!toolSandboxActive()) return { ...process.env } as Record<string, string>;
	const allow = (process.env.HARNESS_KERNEL_ENV_ALLOW ?? "PATH,HOME,TMPDIR,TMP,TEMP,USER,LOGNAME,SHELL,TERM,TZ,LANG,LC_ALL,LC_CTYPE,HARNESS_*,PRIME_AGENT_*")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined) continue;
		if (allow.some((a) => (a.endsWith("*") ? k.startsWith(a.slice(0, -1)) : k === a))) out[k] = v;
	}
	return out;
}

// Generous: read.ts's own truncation runs after the full read in the default
// ops too. The cap only exists so a pathological path cannot wedge node.
const TOOL_SANDBOX_MAX_BYTES = 32 * 1024 * 1024;

function toolSandboxPython(): string {
	return (
		process.env.PRIME_AGENT_KERNEL_PYTHON ??
		toolSandboxJoin(process.env.HOME ?? "/tmp", ".prime/agent/kernel-venv/bin/python")
	);
}

function toolSandboxScriptPath(): string {
	// Must be readable INSIDE the sandbox: the arm's settings allow its per-job
	// TMPDIR and /tmp; tests point HARNESS_TOOL_SANDBOX_SCRIPT_DIR at their own
	// allowed scratch. Written on every call — one tmpfs write against a
	// process spawn — so a cleaned-up round dir cannot strand a stale path.
	const dir = process.env.HARNESS_TOOL_SANDBOX_SCRIPT_DIR ?? process.env.TMPDIR ?? "/tmp";
	const path = toolSandboxJoin(dir, "prime-tool-sandbox-ops.py");
	toolSandboxWriteFileSync(path, TOOL_SANDBOX_OPS_PY);
	return path;
}

/**
 * EISDIR text for the read tool. The read op answers every directory (a skill
 * dir with its SKILL.md, any other with its listing), so this is reached only by
 * a stat race or a non-read op: keep the guidance anyway.
 */
function toolSandboxEisdir(op: string, p: string): string {
	const plain = `EISDIR: illegal operation on a directory, ${op} '${p}'`;
	if (op !== "read" && op !== "access") return plain;
	return `${plain}. Use ls to list a directory.`;
}

function sandboxedFsOp(op: string, p: string): Promise<Buffer> {
	const { bin, args } = toolSandboxWrap(toolSandboxPython(), [toolSandboxScriptPath()]);
	return new Promise((resolve, reject) => {
		const child = toolSandboxSpawn(bin, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...toolSandboxChildEnv(), HARNESS_TOOL_SANDBOX_OP: op, HARNESS_TOOL_SANDBOX_PATH: p },
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let n = 0;
		let settled = false;
		const fail = (e: Error) => {
			if (settled) return;
			settled = true;
			reject(e);
		};
		child.stdout.on("data", (d: Buffer) => {
			n += d.length;
			if (n > TOOL_SANDBOX_MAX_BYTES) {
				child.kill("SIGKILL");
				fail(new Error(`sandboxed ${op} of '${p}': output exceeds ${TOOL_SANDBOX_MAX_BYTES} bytes`));
				return;
			}
			out.push(d);
		});
		child.stderr.on("data", (d: Buffer) => err.push(d));
		child.on("error", fail);
		child.on("close", (code) => {
			if (settled) return;
			if (code === 0) {
				settled = true;
				resolve(Buffer.concat(out));
				return;
			}
			const tag = Buffer.concat(err).toString().trim();
			// The correction lives in the error, not the prompt: name the world.
			if (tag === "EACCES") {
				fail(
					new Error(
						`EACCES: permission denied, ${op} '${p}'. This path is outside the job's world — ` +
							`the same sandbox that runs your cells governs this tool. Readable: the workspace, ` +
							`the api/ and skills/ surface, and /tmp.`,
					),
				);
			} else if (tag === "ENOENT") {
				fail(new Error(`ENOENT: no such file or directory, ${op} '${p}'`));
			} else if (tag === "EISDIR") {
				fail(new Error(toolSandboxEisdir(op, p)));
			} else if (tag === "ENOTDIR") {
				fail(new Error(`ENOTDIR: not a directory, ${op} '${p}'`));
			} else {
				fail(new Error(`sandboxed ${op} of '${p}' failed (exit ${code}): ${tag || "no diagnostic"}`));
			}
		});
	});
}

/**
 * ToolsOptions fragment carrying sandboxed operations for read/grep/find/ls.
 * Spread LAST where tools are created, so the sandbox wins over any caller ops.
 * `find` has no entry at all: its fd path activates only when no custom ops
 * carry a glob, and the fd SPAWN is wrapped at its call site — real fd
 * semantics inside the sandbox beat a reimplementation outside it. (Its
 * host-side pathExists probes are metadata only.)
 */
export function toolSandboxOptions(): Record<string, unknown> {
	if (!toolSandboxActive()) return {};
	return {
		read: {
			operations: {
				access: async (p: string) => {
					await sandboxedFsOp("access", p);
				},
				readFile: (p: string) => sandboxedFsOp("read", p),
				// Same detector as stock's default (utils/mime.ts), fed by a sandboxed
				// head read instead of a host-side open(). `operations` replaces the
				// defaults wholesale, so until W126 the sandboxed tool had NO sniff and
				// read every image as utf-8 text; keeping stock's op instead would
				// open() host-side and EISDIR on the skill directory `access` admits.
				detectImageMimeType: async (p: string) => {
					const head = await sandboxedFsOp("sniff", p);
					if (head.length === 0) return null;
					const kind = await toolSandboxFileType(head);
					if (!kind) return null;
					return new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]).has(kind.mime) ? kind.mime : null;
				},
			},
		},
		grep: {
			operations: {
				isDirectory: async (p: string) => (await sandboxedFsOp("isdir", p)).toString() === "1",
				readFile: async (p: string) => (await sandboxedFsOp("readtext", p)).toString(),
			},
		},
		ls: {
			operations: {
				exists: async (p: string) => (await sandboxedFsOp("exists", p)).toString() === "1",
				stat: async (p: string) => {
					const j = JSON.parse((await sandboxedFsOp("stat", p)).toString()) as {
						dir: boolean;
						size: number;
						mtimeMs: number;
					};
					return { isDirectory: () => j.dir, size: j.size, mtimeMs: j.mtimeMs };
				},
				readdir: async (p: string) => JSON.parse((await sandboxedFsOp("readdir", p)).toString()) as string[],
			},
		},
	};
}