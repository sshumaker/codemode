/**
 * Certification for the remote-kernel backend: the harness's sandbox-check
 * (runtime/eval/sandbox-check.mjs) asks srt's boundary its questions from the
 * inside; this asks a Daytona sandbox the same ones, from inside the kernel.
 *
 *   - no route out: HTTPS, raw TCP to public addresses, and DNS all fail;
 *   - the one door works: a tool call through the tunnel reaches the loop's proxy;
 *   - no secret anywhere: the loop's model key, Daytona key, egress token and a
 *     connector-token stand-in appear in no env var (the kernel's, or any process's
 *     readable /proc/<pid>/environ) and in no readable file.
 *
 * Probes report evidence, not just verdicts (CLAUDE.md: "log the inputs"). No secret
 * material crosses into the sandbox to be searched for: the probe receives SHA-256
 * digests of the secrets and hashes every credential-shaped token it finds (env
 * values, /proc/<pid>/environ and cmdline, and the files under the scanned roots)
 * to compare. A credential is a whole token in every place it could leak to (an env
 * value, a header, a JSON string), so whole-token matching finds it.
 */
import { createHash, randomBytes } from "node:crypto";

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

/** Python run in the kernel; prints one JSON line of evidence. */
function probeCode(needles, lengths) {
	return `
import json, os, socket, subprocess, urllib.request
out = {}
def attempt(name, fn):
    try:
        fn(); out[name] = "REACHED"
    except Exception as e:
        out[name] = type(e).__name__ + ": " + str(e)[:80]
attempt("https_example", lambda: urllib.request.urlopen("https://example.com", timeout=6).read(1))
attempt("https_anthropic", lambda: urllib.request.urlopen("https://api.anthropic.com", timeout=6).read(1))
attempt("https_pypi", lambda: urllib.request.urlopen("https://pypi.org/simple/", timeout=6).read(1))
attempt("tcp_1.1.1.1_443", lambda: socket.create_connection(("1.1.1.1", 443), timeout=4).close())
attempt("tcp_8.8.8.8_53", lambda: socket.create_connection(("8.8.8.8", 53), timeout=4).close())
attempt("dns_github", lambda: socket.getaddrinfo("github.com", 443))
import hashlib, re, stat
import time
needles = set(${JSON.stringify(needles)})
lengths = set(${JSON.stringify(lengths)})
TOKEN = re.compile(rb"[A-Za-z0-9_\\-+]{16,}")
def hits(data):
    # Only tokens as long as some secret can be one; hashing the rest is wasted work.
    return any(len(t) in lengths and hashlib.sha256(t).hexdigest() in needles for t in TOKEN.findall(data))
t_start = time.time()
secretish = [k for k in os.environ if any(w in k.upper() for w in ("KEY", "SECRET", "PASSWORD", "CREDENTIAL")) or k.upper().endswith("TOKEN")]
out["kernel_env_secretish_names"] = secretish
out["kernel_env_needle_hits"] = [k for k, v in os.environ.items() if hits(v.encode())]
proc_hits = []
for pid in os.listdir("/proc"):
    if not pid.isdigit(): continue
    for part in ("environ", "cmdline"):
        try:
            data = open(f"/proc/{pid}/{part}", "rb").read().replace(b"\\0", b" ")
        except Exception:
            continue
        if hits(data): proc_hits.append(f"{pid}/{part}")
out["proc_needle_hits"] = sorted(set(proc_hits))
# Everywhere this conversation could have written, or the loop could have put
# something: home (the work dir, the runtime's state and bundle), temp dirs, /etc,
# /root, and /opt/harness when the runtime came from the snapshot. Third-party trees
# that predate the conversation (the venv's packages, uv's Python, npm/uv caches)
# are skipped and counted; nothing of the loop's can be in them.
roots = [r for r in ("/home", "/tmp", "/var/tmp", "/etc", "/root", "/workspace", "/opt/harness") if os.path.isdir(r)]
SKIP_DIRS = {"site-packages", "__pycache__", "uv-cache", "uv-python", "node_modules", ".npm", ".cache", ".git", "kernel-venv", "proc", "sys"}
fs_hits, scanned, skipped_big, skipped_dirs = [], 0, 0, []
deadline = time.time() + 240
truncated = False
for root in roots:
    if truncated: break
    for d, dirs, files in os.walk(root):
        if time.time() > deadline:
            truncated = True
            break
        skipped_dirs.extend(os.path.join(d, x) for x in dirs if x in SKIP_DIRS)
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for name in files:
            path = os.path.join(d, name)
            try:
                st = os.lstat(path)
                # Regular files only: a FIFO or socket (the sandbox daemon keeps some)
                # would block open().read() forever.
                if not stat.S_ISREG(st.st_mode): continue
                if st.st_size > 4_000_000:
                    skipped_big += 1; continue
                data = open(path, "rb").read()
            except Exception:
                continue
            scanned += 1
            if hits(data): fs_hits.append(path)
out["fs_scanned_roots"] = roots
out["fs_files_scanned"] = scanned
out["fs_files_skipped_large"] = skipped_big
out["fs_needle_hits"] = fs_hits
out["fs_skipped_dirs"] = skipped_dirs[:40]
out["fs_scan_truncated"] = truncated
out["probe_seconds"] = round(time.time() - t_start, 1)
print("CERT " + json.dumps(out))
`;
}

/**
 * @param {object} args
 * @param {{execute(code: string): Promise<{stdout: string, status: string}>}} args.km  a started RemoteKernelManager
 * @param {Record<string, string>} args.secrets  name -> value held on the loop side
 * @param {() => Promise<boolean>} [args.toolDoorWorks]  proves the tunnel still answers
 */
export async function certifySandbox({ km, secrets, toolDoorWorks }) {
	// Positive control: a value planted in the work dir on purpose. A scan that cannot
	// find it proves nothing by finding nothing else.
	const control = `cert_control_${randomBytes(12).toString("hex")}`;
	await km.execute(`open("cert-control.txt", "w").write("planted ${control}\\n")`);
	const present = [...Object.entries(secrets), ["PLANTED_CONTROL", control]].filter(
		([, v]) => typeof v === "string" && v.length >= 16,
	);
	const needles = present.map(([, v]) => digest(v));
	const lengths = [...new Set(present.map(([, v]) => Buffer.byteLength(v)))];
	const r = await km.execute(probeCode(needles, lengths));
	const line = r.stdout.split("\n").find((l) => l.startsWith("CERT "));
	if (!line) throw new Error(`certification probe produced no evidence: ${r.status} ${r.stdout.slice(-500)}`);
	const ev = JSON.parse(line.slice(5));
	const blocked = (k) => ev[k] !== "REACHED";
	const controlHits = ev.fs_needle_hits.filter((p) => p.endsWith("/cert-control.txt"));
	ev.fs_needle_hits = ev.fs_needle_hits.filter((p) => !p.endsWith("/cert-control.txt"));
	const checks = [
		...["https_example", "https_anthropic", "https_pypi", "tcp_1.1.1.1_443", "tcp_8.8.8.8_53", "dns_github"].map((k) => ({
			name: `no egress: ${k}`,
			ok: blocked(k),
			detail: ev[k],
		})),
		{ name: "the scan finds a planted control value", ok: controlHits.length === 1, detail: controlHits },
		{ name: "kernel env has no secret-shaped names", ok: ev.kernel_env_secretish_names.length === 0, detail: ev.kernel_env_secretish_names },
		{ name: "kernel env holds no loop secret", ok: ev.kernel_env_needle_hits.length === 0, detail: ev.kernel_env_needle_hits },
		{ name: "no process env/cmdline holds a loop secret", ok: ev.proc_needle_hits.length === 0, detail: ev.proc_needle_hits },
		{
			name: "no readable file holds a loop secret",
			ok: ev.fs_needle_hits.length === 0 && ev.fs_files_scanned > 0 && !ev.fs_scan_truncated,
			detail: {
				hits: ev.fs_needle_hits,
				roots: ev.fs_scanned_roots,
				scanned: ev.fs_files_scanned,
				skippedLarge: ev.fs_files_skipped_large,
				skippedDirs: ev.fs_skipped_dirs,
				truncated: ev.fs_scan_truncated,
				probeSeconds: ev.probe_seconds,
			},
		},
	];
	if (toolDoorWorks) checks.push({ name: "the one door (tool tunnel) still works", ok: await toolDoorWorks() });
	return {
		ok: checks.every((c) => c.ok),
		checks,
		secretsChecked: present.map(([k]) => k).filter((k) => k !== "PLANTED_CONTROL"),
		needleDigest: createHash("sha256").update(needles.join("\n")).digest("hex").slice(0, 12),
	};
}
