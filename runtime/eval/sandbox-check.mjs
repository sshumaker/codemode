// Does the boundary actually hold? A sandbox that silently allows everything is
// indistinguishable from a working one unless you try to cross it.
//
//   node runtime/eval/sandbox-check.mjs <srt-settings.json> <runDir> [env-file]
//
// The env file is the loop's own — the one launch.sh sources, holding the API
// key. It is passed rather than assumed so the probe names the real path that
// must be unreadable, instead of a stand-in that proves nothing.
//
// Probes go in FILES. The first version passed Python via `-c`, and srt re-joins
// argv through bash, so the quoting was mangled and a write that actually succeeds
// was reported as blocked — a test failing for its own reasons is worse than none.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const [settings, runDir, envFile] = process.argv.slice(2);
const SRT = `${process.cwd()}/node_modules/.bin/srt`;
const PY = `${process.env.HOME}/.prime/agent/kernel-venv/bin/python`;
const dir = mkdtempSync(join(tmpdir(), "sbxprobe-"));
// A read probe must fail on CONTENT, not on absence: open() of a path that is
// merely missing raises the same way a denied one does, and would pass this
// check for the wrong reason. So every read probe asserts it got bytes.
const readProbe = (path) => `open(${JSON.stringify(path)},"rb").read(1)`;
const probes = [
  ["write inside runDir", `open(${JSON.stringify(runDir + "/sbx-inside.txt")},"w").write("x")`, true],
  ["write to HOME", `open(${JSON.stringify(process.env.HOME + "/sbx-escape.txt")},"w").write("x")`, false],
  ["write to /etc", `open("/etc/sbx-escape.txt","w").write("x")`, false],
  ["read ~/.ssh", `import os;os.listdir(os.path.expanduser("~/.ssh"))`, false],
  // The loop's credentials. srt has no read allow-list, so this is enforced by
  // denyRead over the whole home directory with the kernel's own paths allowed
  // back (see runtime/eval/run.mjs); the two probes below are the both-sides
  // evidence that the deny is broad AND that the allowances are real.
  ...(envFile ? [["read the loop env file", readProbe(envFile), false]] : []),
  ["read a HOME dotfile", `import os,glob;open(glob.glob(os.path.expanduser("~/.*rc"))[0],"rb").read(1)`, false],
  ["read the runtime dir", readProbe(`${process.cwd()}/runtime/jobs.py`), true],
  ["read the kernel venv", readProbe(`${process.env.HOME}/.prime/agent/kernel-venv/pyvenv.cfg`), true],
  ["network egress", `import urllib.request;urllib.request.urlopen("https://example.com",timeout=8).read(1)`, false],
  ["spawn a child", `import subprocess;subprocess.run(["echo","hi"],check=True)`, true],
];
let bad = 0;
for (const [i, [label, code, shouldWork]] of probes.entries()) {
  const f = join(dir, `p${i}.py`);
  writeFileSync(f, code);
  const r = spawnSync(SRT, ["--settings", settings, PY, f], { encoding: "utf8", timeout: 30000 });
  const worked = r.status === 0;
  const ok = worked === shouldWork;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(22)} ${worked ? "allowed" : "blocked"}${ok ? "" : `  <- expected ${shouldWork ? "allowed" : "blocked"}`}`);
}
process.exit(bad ? 1 : 0);
