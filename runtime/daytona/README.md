# Remote kernel on Daytona

Prime's agent loop runs in the gateway. Each conversation's Python kernel, and every
file tool, runs in that conversation's Daytona sandbox, reached over one WebSocket.
The sandbox has no outbound network after setup. Tool calls travel back over the
same socket to the loop, which forwards them to the gateway's tool proxy and adds
the egress token on its own side.

```
gateway ── DaytonaKernelProvider.ensure(id) ──► Daytona API (create/start, lock egress, launch server)
   │
   └─ prime --mode rpc   env: connectionEnv(info)
        │  RemoteKernelLink (one wss:// per process: kernel + read/grep/find/ls/write/edit/bash + tool tunnel)
        ▼
      sandbox: kernel-server (8765) ── KernelManager ── ipykernel (ZMQ on loopback)
                     └── 127.0.0.1:<port>/k/<kernel>/call  ◄── api/_client.py (HARNESS_MCP_PROXY)
```

## What the gateway calls

```js
import { DaytonaKernelProvider, connectionEnv, connectFileContents } from "<HARNESS_ROOT>/runtime/daytona/provider.mjs";

const kernels = new DaytonaKernelProvider({
  // apiKey/apiUrl/target default to DAYTONA_API_KEY / DAYTONA_API_URL / DAYTONA_TARGET
  labels: { env: "prod" },        // optional; {app: "assistant-workspace"} is always added
  autoStopMinutes: 15,            // Daytona's safety net if stop() is never called
});
```

| call | returns | what it does |
| --- | --- | --- |
| `ensure(conversationId, { mounts? })` | `KernelConnectionInfo` | Find the sandbox labelled `app=assistant-workspace, conversation=<id>`, or create it (name `aw-<id>-<hash>`); start it if stopped; install the runtime if the sandbox does not hold the current bundle version; lock egress (`networkBlockAll`); start or verify the kernel server; upload each mount once per content hash; return how to connect. Refuses (throws) unless the server's own probe says egress is blocked. Calls for one conversation are serialised. |
| `stop(conversationId)` | `{stopped, sandboxId?}` | On idle. SIGTERMs the kernel server first so kernels flush their namespace snapshots, then stops the sandbox. Files, the venv and snapshots persist. |
| `destroy(conversationId)` | `{destroyed, sandboxId?}` | On conversation delete. |
| `touch(conversationId)` | — | `refreshActivity()`; call during long turns so auto-stop does not fire mid-turn. |
| `listOrphans({ knownConversationIds? })` | `Orphan[]` | Sandboxes with this provider's labels whose conversation is not in the set (all of them if no set). |
| `reap({ knownConversationIds? })` | `Orphan[]` deleted | Delete every orphan. |
| `uploadFile(conversationId, path, data)` | sandbox path | `path` relative to the work dir, e.g. `inputs/report.pdf`. Anything escaping the work dir is refused. |
| `listFiles(conversationId, dir = "outputs")` | `SandboxFile[]` | `{name, path, relPath, isDir, size, modTime}`. |
| `readFile(conversationId, path)` | `Buffer` | e.g. `outputs/chart.png`. |

Types are in `provider.d.ts`. `KernelConnectionInfo` is
`{conversationId, sandboxId, url, token, headers, remoteCwd, mounts, posture, version, created, timings}`.

### Starting prime against it

```js
const info = await kernels.ensure(id, { mounts: [{ local: apiTreeDir, remote: "api" }, { local: skillsDir, remote: ".skills" }] });
spawn(prime, ["--mode", "rpc", "--cwd", localWorkDir, ...], {
  env: {
    ...baseEnv,
    ...connectionEnv(info),                 // HARNESS_REMOTE_KERNEL_{URL,TOKEN,HEADERS,CWD,PATH_MAP}
    HARNESS_MCP_PROXY: "http://127.0.0.1:8787/tools",   // the gateway's proxy, reached from the LOOP
    HARNESS_EGRESS_TOKEN: egressTokenFor(id),           // stays in the loop; never enters the sandbox
    HARNESS_KERNEL_AUTORESTART: "1",
  },
});
```

For a long-lived prime process, prefer the connect file: write
`connectFileContents(info)` to a path, set `HARNESS_REMOTE_KERNEL_CONNECT_FILE` to it,
and rewrite it after every `ensure()`. The loop re-reads it on each (re)connect, so a
sandbox restarted by the gateway (new preview token) is picked up without restarting
prime.

`PUBLIC_GATEWAY_URL` is not needed for the kernel: nothing in the sandbox dials the
gateway. The sandbox is only ever dialled into.

## Environment (prime / loop side)

| var | meaning |
| --- | --- |
| `HARNESS_REMOTE_KERNEL_URL` | `wss://` of the kernel server. Setting it (or the connect file) switches the kernel and all file tools to remote. |
| `HARNESS_REMOTE_KERNEL_TOKEN` | the server's shared secret |
| `HARNESS_REMOTE_KERNEL_HEADERS` | JSON upgrade headers (`x-daytona-preview-token`) |
| `HARNESS_REMOTE_KERNEL_PREVIEW_TOKEN` | shorthand for the header above |
| `HARNESS_REMOTE_KERNEL_CONNECT_FILE` | JSON `{url, token, headers}`, re-read on every reconnect; wins over the three above |
| `HARNESS_REMOTE_KERNEL_CWD` | kernel cwd in the sandbox (`/home/daytona/work`) |
| `HARNESS_REMOTE_KERNEL_PATH_MAP` | JSON `[{local, remote}]`; the loop cwd → remote cwd pair is always added |
| `HARNESS_REMOTE_KERNEL_GRACE_MS` | keep reconnecting a dropped socket this long (default 240000) |
| `HARNESS_REMOTE_KERNEL_PING_MS` / `_DEAD_MS` | heartbeat interval / presumed-dead silence (10000 / 30000) |
| `HARNESS_REMOTE_TOOL_PROXY` | where tunnelled tool calls go; default `HARNESS_MCP_PROXY` |
| `HARNESS_REMOTE_TOOL_TIMEOUT_MS` | per tool call (default 960000, i.e. 16 min: a call can wait 15 min on approval) |
| `HARNESS_REMOTE_KERNEL_DEBUG=1` | connection-state log lines on stderr |

The generated `api/_client.py` has its own `_TIMEOUT = 180` (bench/generate.mjs). For
approvals that can take 15 minutes the gateway's `build-api.mjs` must raise it; the
tunnel itself imposes no 180 s limit.

## Boundary and posture

The Daytona sandbox is the kernel's only boundary, and the backend says so rather
than implying it:

- The loop never starts a local kernel in remote mode. The server sets
  `HARNESS_KERNEL_SANDBOX=off` for its own KernelManager, and refuses every `start`
  while its egress probe (TCP to 1.1.1.1:443 and 8.8.8.8:53, DNS + TCP to pypi.org)
  reaches anything, unless `KERNEL_SERVER_ALLOW_OPEN_EGRESS=<reason>` says why (only
  the local fake sets it). The verdict and the probe's evidence are in every
  `welcome`, every `start` result, the startup progress line ("Kernel boundary:
  daytona-sandbox; egress blocked"), and `/healthz`.
- `ensure()` sets `networkBlockAll` before handing out a connection and refuses if the
  server's probe disagrees.
- The kernel's environment is built, not inherited: an allow-list from the server's
  env plus the loop's per-kernel env with secret-shaped names dropped (the loop's
  websearch key rides there), loop-local dirs remapped, and `HARNESS_MCP_PROXY` pinned
  to the loopback tunnel.
- Tool calls leave only as socket messages. The loop adds `x-egress-token`; the
  sandbox never sees it.
- `runtime/daytona/certify.mjs` checks all of this from inside the kernel; the live
  test runs it (no egress by HTTPS/TCP/DNS, tool door open, the loop's model key /
  Daytona key / egress token / a connector token absent from every env, every
  readable `/proc/<pid>/environ` and `cmdline`, and every scanned file — matched by
  SHA-256 of whole tokens, so no secret material enters the sandbox to be searched for).

## Runtime in the sandbox

`bundle.mjs` builds the kernel-server package from the compiled vendored prime
(`dist/kernel-server.mjs` + bundled skills + `prime-agent-runtime`); its content hash
is the version. Layout: `<root>/kpkg`, `<root>/kernel-venv`, `<root>/state/{skills,snapshots,kernels,server.json,kernel-server.log}`,
work dir `~/work/{inputs,outputs}`.

- **Snapshot** `harness-assistant-kernel-<version>` (`snapshot.mjs`, root `/opt/harness`):
  node 22, zeromq, uv, ripgrep/fd, and the venv with the bundled Python skills
  prebaked at their content-addressed paths. Created with no network at all.
- **Fallback** (no snapshot): the stock image, root `~/.harness-runtime`; `ensure()`
  uploads the bundle, installs zeromq and uv, runs `--prebake`, then locks egress.
  With an older `harness-assistant-kernel-*` snapshot, only the bundle is replaced.

## Tests

```bash
npm run test:remote-kernel        # unit + link state machine + the fake suite (local ipykernel, no Daytona)
RK_PRIME_TURN=1 npm run test:remote-kernel   # ...plus one real Haiku turn against the fake
npm run test:remote-kernel:live   # the same suite on Daytona with egress blocked, lifecycle, certification, a prime turn
```

Live tests label sandboxes `{app: assistant-workspace, purpose: harness-remote-kernel-dev, env: test}`
and reap them at the end, asserting none remain.
