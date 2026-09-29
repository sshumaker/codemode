// Does the boundary actually hold? A sandbox that silently allows everything is
// indistinguishable from a working one unless you try to cross it.
//
//   node runtime/eval/sandbox-check.mjs <srt-settings.json> <runDir> [env-file] [proxy-url] [token]
//
// The env file is the loop's own — the one launch.sh sources, holding the API
// key. It is passed rather than assumed so the probe names the real path that
// must be unreadable, instead of a stand-in that proves nothing.
//
// The proxy URL and token are the run's live egress proxy. They turn the last
// two probes from "the sandbox is sealed" into "the sandbox is sealed EXCEPT
// through the one door, and that door checks the key" — which is the actual
// claim. A boundary with exactly one opening is only as good as the check on
// that opening, so the wrong-token probe is not a nicety.
//
// Probes go in FILES. The first version passed Python via `-c`, and srt re-joins
// argv through bash, so the quoting was mangled and a write that actually succeeds
// was reported as blocked — a test failing for its own reasons is worse than none.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startEgress } from "../posture.mjs";

// The runtime directory this file lives under; the unix-socket probe imports
// jobs.py from it rather than reimplementing the client.
const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [settings, runDir, envFile, proxyArg, tokenArg] = process.argv.slice(2);

// `auto` starts a proxy for the length of the check. Without it the egress
// probes need a live proxy assembled by hand, and a check that is awkward to
// run is a check that stops being run — which is how this project ended up
// with rules it believed were in force and no test that executed them.
let egress;
if (proxyArg === "auto") {
  mkdirSync(join(runDir, "jobs/requests"), { recursive: true });
  egress = startEgress({ runDir, spawnDir: join(runDir, "jobs/requests"), routes: [], session: "sandbox-check" });
  console.log(`[egress] ${egress.url}`);
}
const proxyUrl = egress ? egress.url : proxyArg;
const proxyToken = egress ? egress.token : tokenArg;
const SRT = process.env.HARNESS_SRT_BIN ?? `${process.cwd()}/node_modules/.bin/srt`;
// The kernel's own interpreter, since that is the process whose boundary is under
// test. Overridable by the same variable the harness uses to point a container's
// kernel at its venv, so the check can run where the kernel runs.
const PY = process.env.PRIME_AGENT_KERNEL_PYTHON ?? `${process.env.HOME}/.prime/agent/kernel-venv/bin/python`;
const dir = mkdtempSync(join(tmpdir(), "sbxprobe-"));
// A read probe must fail on CONTENT, not on absence: open() of a path that is
// merely missing raises the same way a denied one does, and would pass this
// check for the wrong reason. So every read probe asserts it got bytes.
const readProbe = (path) => `open(${JSON.stringify(path)},"rb").read(1)`;

/** Does the settings file under test re-allow reads under `path`? */
const settingsJson = JSON.parse(readFileSync(settings, "utf8"));
const declaresRead = (path) =>
  (settingsJson.filesystem?.allowRead ?? []).some((allowed) => {
    const a = resolve(allowed);
    return resolve(path) === a || resolve(path).startsWith(`${a}/`);
  });
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
  // Asserted in whichever direction THIS settings file claims. Not every posture
  // grants the runtime directory — MCP-Bench has no jobs runtime, so its kernel
  // has no business reading runtime/jobs.py, and a probe hard-coded to "allowed"
  // reported a correct boundary as a failure. Either way it is a real assertion:
  // it checks that srt enforces exactly what the settings declare, and a
  // declaration that is not enforced is the whole thing being tested for.
  ["read the runtime dir", readProbe(`${process.cwd()}/runtime/jobs.py`), declaresRead(`${process.cwd()}/runtime`)],
  ["read the kernel venv", readProbe(join(dirname(dirname(PY)), "pyvenv.cfg")), true],
  // Another run's file in the shared temp dir: the reads a trace's `find /` made.
  ["read another tmp dir", readProbe(join(dir, "other-run.txt")), false],
  ["network egress", `import urllib.request;urllib.request.urlopen("https://example.com",timeout=8).read(1)`, false],
  ["spawn a child", `import subprocess;subprocess.run(["echo","hi"],check=True)`, true],
  // The door, and the lock on it. Both probes POST a deliberately malformed
  // body, so neither can start a real subagent: with the run's token the proxy
  // gets far enough to reject the BODY (400), which is proof authentication
  // passed; with a wrong token it must never look at the body at all (401).
  //
  // Asserting the status rather than mere reachability matters — urlopen raises
  // on both 400 and 401, so a probe that only checked "did it throw" would pass
  // identically whether the lock worked or not.
  //
  // These two report "authenticated"/"refused" rather than the allowed/blocked
  // wording the filesystem probes use: for the wrong-token probe the passing
  // outcome IS a refusal, and printing "allowed" next to it says the opposite of
  // what happened to anyone skimming the output.
  ...(proxyUrl && proxyToken
    ? [
        ["egress: run's token", spawnProbe(proxyUrl, proxyToken, 400), true, ["authenticated", "rejected"]],
        ["egress: wrong token", spawnProbe(proxyUrl, "egr-not-the-token", 401), true, ["refused (401)", "not refused"]],
      ]
    : []),
];

/**
 * POST /control/spawn and insist on an exact status; anything else exits non-zero.
 *
 * Two transports, because the proxy has two doors and which one a sandbox can use
 * is a property of the platform, not of the check (posture.mjs
 * defaultEgressListen). The unix form goes through jobs.py's own client rather
 * than a second implementation of it: the thing being certified is the client the
 * kernel actually uses, and a probe that spoke the socket differently could pass
 * while `spawn()` failed.
 */
function spawnProbe(url, token, wantStatus) {
  if (url.startsWith("unix:")) {
    return [
      `import sys`,
      `sys.path.insert(0, ${JSON.stringify(RUNTIME)})`,
      `import jobs`,
      `got, reason = jobs._egress_post(${JSON.stringify(url)}, "/control/spawn", b"not-a-spawn-request",`,
      `    {"content-type": "application/json", "x-egress-token": ${JSON.stringify(token)}}, timeout=8)`,
      `assert got == ${wantStatus}, f"proxy answered {got} {reason}, want ${wantStatus}"`,
    ].join("\n");
  }
  return [
    `import json,urllib.request,urllib.error`,
    `req = urllib.request.Request(${JSON.stringify(url.replace(/\/$/, "") + "/control/spawn")},`,
    `  data=b'not-a-spawn-request',`,
    `  headers={"content-type":"application/json","x-egress-token":${JSON.stringify(token)}},`,
    `  method="POST")`,
    `try:`,
    `    got = urllib.request.urlopen(req, timeout=8).status`,
    `except urllib.error.HTTPError as e:`,
    `    got = e.code`,
    `assert got == ${wantStatus}, f"proxy answered {got}, want ${wantStatus}"`,
  ].join("\n");
}
let bad = 0;
writeFileSync(join(dir, "other-run.txt"), "another run\n");
for (const [label, code, shouldWork, words = ["allowed", "blocked"]] of probes) {
  // Inline, not a file under `dir`: the shared temp dir is outside the sandbox now.
  const r = spawnSync(SRT, ["--settings", settings, PY, "-c", code], { encoding: "utf8", timeout: 30000 });
  const worked = r.status === 0;
  const ok = worked === shouldWork;
  if (!ok) bad++;
  const [yes, no] = words;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(22)} ${worked ? yes : no}` +
      // The probe's own words when it disagrees. A failing probe that prints only
      // its verdict is the thing this repo has been burned by: the reason lives
      // in the stderr nobody kept.
      (ok ? "" : `  <- expected ${shouldWork ? yes : no}\n${(r.stderr ?? "").trim().split("\n").slice(-3).map((l) => `        ${l}`).join("\n")}`),
  );
}
egress?.stop();
process.exit(bad ? 1 : 0);
