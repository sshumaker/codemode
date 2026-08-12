// Does the boundary actually hold? A sandbox that silently allows everything is
// indistinguishable from a working one unless you try to cross it.
//
// Probes go in FILES. The first version passed Python via `-c`, and srt re-joins
// argv through bash, so the quoting was mangled and a write that actually succeeds
// was reported as blocked — a test failing for its own reasons is worse than none.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const [settings, runDir] = process.argv.slice(2);
const SRT = `${process.cwd()}/node_modules/.bin/srt`;
const PY = `${process.env.HOME}/.prime/agent/kernel-venv/bin/python`;
const dir = mkdtempSync(join(tmpdir(), "sbxprobe-"));
const probes = [
  ["write inside runDir", `open(${JSON.stringify(runDir + "/sbx-inside.txt")},"w").write("x")`, true],
  ["write to HOME", `open(${JSON.stringify(process.env.HOME + "/sbx-escape.txt")},"w").write("x")`, false],
  ["write to /etc", `open("/etc/sbx-escape.txt","w").write("x")`, false],
  ["read ~/.ssh", `import os;os.listdir(os.path.expanduser("~/.ssh"))`, false],
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(20)} ${worked ? "allowed" : "blocked"}${ok ? "" : `  <- expected ${shouldWork ? "allowed" : "blocked"}`}`);
}
process.exit(bad ? 1 : 0);
