# Containerized runtime — design record

The structural answer to "opsctl is on my machine… why is it able to
access any executables". The `HARNESS_FS_GUARD` and `HARNESS_EXEC_GUARD` gates are
in-process mitigations that scan cell source; this replaces the scan with a
boundary. **Built and measured** — the image exists, a real print-mode session has
run inside it, and every number below was taken rather than estimated.

Everything lives in `bench/container/`:

    build.sh              stages a 32MB context and builds the image
    Dockerfile            node + dist + kernel venv, all pinned
    kernel-requirements.txt  generated from the host kernel venv
    verify-kernel.py      imports every module at BUILD time
    smoke.sh              the five boundary assertions
    smoke-payload.py      … their in-container half
    mock-forwarder.py     host-side stand-in for the MCP forwarder
    model-relay.py        host-side model hop; the key stays host-side
    run-session.mjs       runs prime for real in the container, and times it
    network-posture.sh    what the container can reach, per network mode
    network-probe.py      … the four probes
    sidecar-forward.py    the component that makes full egress denial work

## Verified before designing

`host.docker.internal` resolves and routes from a linux container on this
machine's runtime (colima, macOS Virtualization.Framework, aarch64, docker
29.5.2, virtiofs):

    getent hosts host.docker.internal  ->  192.168.5.2
    nc -z host.docker.internal 8899    ->  REACHED   (host-side 127.0.0.1 listener)

That was the one gate that could have killed the design: it decides whether the
tool transport can reach a host-side forwarder. It can.

## The shape, and the trap it avoids

**Everything runs inside the container**: node, prime's `dist/bundle/cli.js`, and a
python venv with ipykernel. NOT "kernel inside, harness outside" — prime's CLI
speaks ZMQ to ipykernel on ports that do not cross the colima VM boundary, and the
first TAC attempt to work around that produced a hand-rolled kernel driven over
`docker exec` plus hand-rolled tools, i.e. two reimplementations whose divergences
were invisible until one of them silently dropped image attachments and cost a
task. CLAUDE.md: run the real harness, not a reimplementation of it.

The bundle externalizes `zeromq` and `undici`, so both are installed in-container.

## Where the boundary is

| | inside | crosses | outside |
|---|---|---|---|
| filesystem | the job dir (rw), `api/` mounted **ro** | — | everything else — no host mounts |
| executables | image contents only | — | every host binary, including the operator's |
| tool calls | — | HTTP to `host.docker.internal:<forwarder>` | the forwarder and the product |
| model traffic | — | HTTP to `host.docker.internal:<relay>` | the model API |
| general outbound | — | **open by default** | the whole internet — see §Network posture |

`bench/container/smoke.sh`, green on `python:3.11-slim` and on the runtime image:

    (a) forwarder: {'ok': True, 'text': 'forwarded:judge_tool'}
    (b) host binaries absent: opsctl, colima, brew, osascript, security
    (c) host paths unreachable: 4 of 4
    (d) api/ readable, read-only
    (e) job dir writable
    PASS: 5/5

A cell that greps for `opsctl` fails because the binary does not exist,
not because a regex caught it, and a cell that reads `~/.prime/agent/daemon-state.json`
fails because the path is not in the mount namespace. That part of the design
holds exactly as intended.

**One operational constraint discovered while building**: on colima only `$HOME`
is shared into the VM over virtiofs, so every bind source — job dir, `api/` tree,
staged scripts — must live under `$HOME`. A `mktemp -d` under macOS `$TMPDIR`
produces `docker: invalid mount config … bind source path does not exist`. This
checkout lives under `/tmp` and therefore cannot itself be mounted.

## Key handling — the decision, and how far it actually got

**Decision: the model key does not enter the container.** Implemented and
verified: `bench/container/model-relay.py` runs host-side, reads
`ANTHROPIC_API_KEY` from its own environment once at startup, and the container
receives a per-run token in `ANTHROPIC_API_KEY` instead. Every run above went
through it — `relay-audit.jsonl` shows `POST /v1/messages 200`, and the token in
the container's environment is not a credential anywhere else.

Three things this did **not** turn out to be:

1. **It could not use `proxy/egress`.** That proxy refuses at config-load to route
   to any model provider (`isProviderHost`, `proxy/egress/main.go:204`):
   "Intelligence reaches the sandbox as spawn() — a subagent the harness starts,
   budgeted and traced — not as a provider call from a cell." That guard is right
   for the deployed shape, where the harness is on the host and only cells are
   sandboxed. Containerizing the harness puts prime's *own* provider traffic
   inside the boundary, which the guard will not carry. The relay is a separate
   process so the guard stays intact — but the tension is real and belongs in
   whatever the hosted design settles on.
2. **`ANTHROPIC_BASE_URL` does not work.** Every anthropic entry in prime's
   built-in registry carries `baseUrl: "https://api.anthropic.com"` explicitly and
   `createClient` passes it to `new Anthropic({ baseURL })`, so the SDK's env
   fallback never fires. Measured: with `ANTHROPIC_BASE_URL` pointed at a dead
   port the run still reached the real API and returned a genuine 401 with an
   Anthropic `request_id`. The supported override is a `models.json` in the agent
   dir re-declaring the model with the relay's `baseUrl`; `run-session.mjs`
   writes one.
3. **The token is not a budget boundary.** Inside the container, whatever the
   harness can reach a cell can reach, so a cell can spend model budget through
   the relay. It cannot *exfiltrate* the key, which is the property the TAC
   incident was about (`run_multi_npc.py` put a real key in `ps` and
   `/tmp/npc.log` inside an agent-visible container). Restoring the budget
   property needs a second boundary between harness and cell; this prototype does
   not have one.

## Network posture — measured, four modes

`bench/container/network-posture.sh`, all four run against the real image:

| mode | outbound | tool hop |
|---|---|---|
| default bridge | **OPEN** (dns, raw tcp, and api.anthropic.com all reached) | UP |
| `--internal` network + `--add-host host.docker.internal:host-gateway` | DENIED | **DOWN** |
| `--network none` | DENIED | **DOWN** |
| `--internal` network + dual-homed sidecar container | **DENIED** | **UP** |

So the first honest statement: **as run today — plain `docker run` — outbound is
open, and the boundary is filesystem and executables only.** The container reached
`api.anthropic.com` directly during the very first session, which is how this was
noticed rather than assumed.

The second, better statement: **full denial is achievable on this runtime**, and
the last row is the recipe. `--internal` gives the runtime no route anywhere,
which also kills the tool hop, because on colima `host.docker.internal` is a
macOS-side address reachable only over the default bridge. A sidecar container
attached to **both** networks bridges exactly that one flow:
`bench/container/sidecar-forward.py`, reached by container name, forwarding to the
harness's forwarder. Measured in that posture: dns BLOCKED, raw tcp BLOCKED,
api.anthropic.com BLOCKED, tool hop REACHED.

Two dead ends worth recording so nobody re-walks them:

- **A unix socket does not cross virtiofs.** `posture.mjs` uses a socket for the
  Linux/bwrap case, so it was the obvious way to get a host hop under
  `--network none`. Bind-mounted from macOS the socket file is *visible* inside
  the container and `connect()` returns `ECONNREFUSED` — the socket is a
  host-kernel object and the VM is a different kernel.
- **`--add-host host.docker.internal:host-gateway` on an internal network** maps
  the name to the bridge gateway, which is the linux VM, not the macOS host where
  the forwarder listens. It resolves and then fails to route.

## Numbers — measured

Image `harness-runtime:aarch64`, linux/arm64:

| | value |
|---|---|
| image size | **1.21 GB on disk in the VM**, 260 MB content (compressed layers) |
| build context | 32 MB (staged; the repo root would be gigabytes) |
| build time, cold (no cache, this machine) | **72 s** |
| build time, incremental (pip layers cached) | 23 s |
| first-cell latency, fresh container | **4.02 s** mean (n=5; min 4.00, max 4.05) |
| first-cell latency, prewarmed | **3.48 s** mean (n=2 later sessions in a live container; first was 3.88 s) |
| whole session, fresh container | 5.1–5.3 s |
| first-cell latency, host baseline (same probe) | **4.12 s** mean (n=5; min 3.96, max 4.19) |
| delta vs the current in-process kernel | **none** — container 4.02 s vs host 4.12 s |

What is inside the 1.21 GB: kernel venv 526 MB, node runtime 113 MB, prime's
`dist` 33 MB, the two externals 31 MB, debian base and python the rest. The venv
dominates, as predicted.

Latency method: the clock starts just before `docker run`/`docker exec` and stops
at the first `tool_execution_end` on prime's json stream, so the number includes
container create and start, node boot, ipykernel boot and one Haiku 4.5 round
trip. It is the same envelope `bench/appworld/prewarm.mjs` reports for the host,
and deliberately so.

**Container start plus first-boot page-in costs about 0.5 s** (4.02 s fresh vs
3.48 s in an already-running container). The prewarm lesson does apply, but far
more weakly than on the host: the image layers are read through the VM's page
cache, which stays warm across `--rm` containers. Note the *cold* number here is
"first container from an image the VM has already touched" — isolating a true
first-ever-read would need `drop_caches` in the colima VM, which would perturb the
user's running dev stack, so it was not taken. Say what the number is, not what it
would be nice for it to be.

**The host baseline is a real measurement, on the same machine, same day, same
probe** — but it took a retraction to get. See §The daemon, below: the first
attempt failed on every host run and was written up here as "node 25 cannot reach
the provider", which was wrong.

Container and host are the same speed: **4.02 s vs 4.12 s** to first cell. The
container is nominally 0.1 s faster, which is inside the run-to-run spread of
either group (container 4.00–4.05, host 3.96–4.19), so the honest claim is **no
latency penalty from containerizing**, not a win. Both go through the same
host-side relay and forwarder, so the only difference between the groups is the
container itself.

For context, `bench/appworld/prewarm.mjs` records 5.9 s / 4.8 s for the identical
`print(6*7)` probe on earlier dates. Today's host number is faster than both; do
not mix the two sets.

## The daemon — and a claim this document got wrong

**Retracted:** an earlier version of this file said prime "cannot reach the
provider at all" on this host's node v25.2.1, and attributed it to node 25's fetch
rejecting the `EnvHttpProxyAgent` the bundle installs from externalized undici.
That was an inference from the SDK's error *text*, not from anything measured, and
it is false. The falsifying evidence came from the eval worker, which runs prime
on that exact node binary (`worker-h18.sh:22`) and billed 40+ Together jobs the
same day.

What it actually is: **print mode attaches to a SHARED daemon on a default
socket, and a stale daemon fails every request with the bare string
`Connection error.`** The daemon on this machine was 2 days 11 hours old. Paired
A/B, same command back to back:

    default daemon socket : FAIL: Connection error.
    fresh daemon socket   : PASS: turn completed
    default daemon socket : FAIL: Connection error.

Passing `--daemon-socket <fresh path>` fixes it outright, which is why
`run-session.mjs` now sets one per host run. Containers never needed it: each
container boots its own daemon.

The isolation that got there, all on node v25.2.1 from the same shell:

| dist | provider | result |
|---|---|---|
| `/tmp/harness-execguard` | Anthropic | FAIL |
| `~/src/harness` (`dist/cli.js` too) | Anthropic | FAIL |
| `/tmp/harness-bridgetest` (the arm's) | Anthropic | FAIL |
| `/tmp/harness-bridgetest` | Together (the arm's own models.json) | FAIL |
| any of the above | either | **PASS** with `--daemon-socket` |

Provider is not the variable and dist is not the variable, which is what pointed
at shared process state. And the mechanism I had asserted is directly disproved:
`setGlobalDispatcher(new EnvHttpProxyAgent({...}))` from that same undici 7.28.0,
in a node 25 grandchild process, fetches `api.anthropic.com` and gets its 401.

Two lessons, both already in CLAUDE.md and both re-learned the hard way here.
*Log the inputs, not just the verdicts* — "Connection error." with
`details.kind: "unknown"` is a verdict with no evidence attached, and I filled the
gap with a plausible mechanism instead of a probe. And a stale shared daemon is
the same species as the stale `egress-addr.txt` that `posture.mjs` deletes on
purpose: **state outliving the run that made it, failing in a way that looks like
the network.**

Worth fixing beyond this doc: any runner that starts prime in print mode without
`--daemon-socket` is sharing a daemon with every other prime on the machine.

## The bug that ate the afternoon, because it will bite the next person too

`bench/terminal/provision-agent-volume.sh` wrote a **stub** `package.json` next to
`dist/` so that `npm i zeromq undici` would not try to resolve prime's
workspace-internal `@earendil-works/pi-*` dependencies from a public registry.
That part is necessary. What the stub also does is destroy prime's identity:

    var pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));
    var envPrefix = (pkg.piConfig?.name || "pi").toUpperCase()…
    var ENV_AGENT_DIR = `${envPrefix}_CODING_AGENT_DIR`;

With the stub, `envPrefix` falls back to `PI`, so prime reads
`PI_CODING_AGENT_DIR` and **silently ignores `PRIME_AGENT_CODING_AGENT_DIR`** —
the agent dir, `settings.json` and `models.json` all come from `~/.prime/agent`
instead of the mounted job dir. The visible symptom is one line of output:
`cli.js --version` prints `0.0.0` instead of `0.7.1`. Nothing errors.

`build.sh` derives the manifest from prime's real one, keeping
`name`/`version`/`type`/`piConfig` and dropping only `dependencies`, and
`bench/terminal/provision-agent-volume.sh` now does the same and hard-fails if
the version line ever reads `0.0.0` again.

**`bench/tac/provision-agent-volume.sh` never had this bug** — it copies the real
`packages/` tree, so the real manifest travels with it, and it builds the
externals in an isolated `/tmp/ext` rather than writing a manifest next to
`dist/`. Only terminal-bench's volume was affected. Recorded results from it
stand: provisioning was identical across arms, so a misdirected agent dir was
symmetric; model selection came through flags and env rather than `models.json`;
and `PRIME_AGENT_KERNEL_PYTHON` is hardcoded rather than prefix-derived, so the
kernel was never involved. Note in `docs/TAC-HANDOFF.md` §3.

Three smaller ones, same shape — a plausible result rather than an error:

- **`dist/bundle` alone is not enough.** The bundle opens
  `dist/modes/interactive/theme/prime.json` by path at startup. Copy the whole
  `dist`. A bundle-only image dies at boot with ENOENT before the kernel exists.
- **A buffering relay breaks streaming invisibly.** The first working relay
  returned the model's response whole, and forwarded the client's
  `accept-encoding` so urllib handed back gzip labelled `text/event-stream`. The
  turn came back **200, empty content, zero usage, `stopReason: "stop"`** — a
  success-shaped failure. The relay now streams chunked and forces
  `identity`.
- **`docker run -d -i … < file` does not deliver the redirect.** The sidecar came
  up running an empty program and refused every connection, which reads exactly
  like a blocked network. Mount the script instead.

## What a real run still needs

- `HARNESS_MCP_PROXY` points straight at the forwarder here. A benchmark run under
  the posture uses `{egress}/r/mcp`, which 401s with the current `.run/api` tree:
  it was compiled before `bench/generate.mjs` learned to send `x-egress-token`, so
  its `_client.py` presents no credential. Regenerate the tree before wiring the
  container into a graded run.
- The sidecar posture is proven but not wired into `run-session.mjs`; the runs
  above were on the default bridge, i.e. with outbound open.
- Nothing runs as a non-root user yet. The image's boundary is the mount
  namespace and the image contents, not uid separation.
