# Kernel backends


`runtime/kernel/` decides where a conversation's Python kernel runs, for a host that
runs prime per conversation (a gateway, a hosted service). The host never talks to the
kernel: prime does. A backend tells prime how to reach or launch its kernel, tells the
kernel how to reach the tool proxy, and moves files across whatever boundary separates
the kernel's filesystem from the host's. ES modules with `.d.mts` types, like
`runtime/daytona/`:

```js
import { createKernelBackend, PlacedKernelBackend, startIdleSweep } from "<HARNESS_ROOT>/runtime/kernel/index.mjs";
```

## The contract (`backend.d.mts`)

`KernelBackend.open(ctx: KernelContext)` returns a `KernelSession`:

| part | meaning |
| --- | --- |
| `primeEnv`, `primeCwd` | merged into prime's environment (always includes `HARNESS_MCP_PROXY` and `HARNESS_EGRESS_TOKEN`) and its `--cwd`. Known at `open()`, so prime starts in parallel with the kernel side. |
| `ready` | settles when the kernel side is reachable; rejects with the reason if it never will be. Every file method waits on it. |
| `putInput`, `listOutputs`, `readOutput`, `files` | attachments in, `outputs/` out, and workspace files for tools that take or return one (`WorkspaceFiles`). |
| `workDirAliases` | other absolute spellings of the work dir the kernel may use (a sandbox's own). |
| `restored` | how many workspace files were put back because the sandbox was recreated. |
| `scheduler`, `schedulerPollMs` | `runtime/scheduler.py`, run where this kernel's jobs are. |
| `release()` | prime exited: release sandbox resources (never a stop that could race the next open). |

Optional backend verbs: `start` (once at host startup, e.g. warm a pool), `destroy`
(the conversation was deleted), `sweepIdle`, `drain` (shutdown began), `shutdown`.
`KernelContext` carries the conversation's ids, its host dirs (`convDir`, `workDir`,
`tmpDir`), the shared api tree and skill roots, the egress token, the proxy path and
loopback base URL, an optional `timeZone`, `placement` and `restoreFiles()`.

## The backends

| name | kernel | files |
| --- | --- | --- |
| `local` (`LocalKernelBackend`) | prime's own ipykernel under srt with `posture.mjs`: reads only this conversation's dirs, writes only its work dir and scratch, loopback only, env from the allow-list. macOS only. | the host's own disk; nothing moves. |
| `local-unsafe` | the same with `HARNESS_KERNEL_SANDBOX=off` said explicitly. Throwaway smoke tests only. | the host's own disk. |
| `daytona` (`DaytonaKernelBackend`) | one sandbox per conversation through `runtime/daytona/provider.mjs`; prime speaks one WebSocket to it via a connect file (`pending` until the sandbox is up, then the URL/token, or the error). The egress token never enters the sandbox. | uploaded and read through the sandbox's file API. |

`createKernelBackend({ name, kernelPython, ... })` picks one and refuses what this
machine cannot run safely (`local` off macOS, `daytona` without `DAYTONA_API_KEY`)
instead of degrading to no boundary. Every backend installs harness's startup hooks and
the prelude (`prelude.mjs`); an app adds its own IPython startup files with
`extraStartupFiles: { "07-name.py": source }`. Logging goes to an injected
`log: { info, warn }`.

**Warm pool** (`daytona-pool.mjs`, `poolSize > 0`). Sandboxes created ahead of time
with every upload done, labelled `pool=warm` under this host's `poolOwner`. A new
conversation's first open claims one: a relabel (the pool's keys overwritten, since
Daytona merges labels) and a health check in parallel, then the provider is bound to
the sandbox id because label search lags a relabel. A claim waits for a sandbox that
is already warming; a failed or hung warm sends it cold. Leftovers from a previous
process are adopted on start; `drain`/`shutdown` delete what is left.

**Idle sweep and restore.** `sweepIdle` deletes this host's conversation sandboxes
(owner label only, never `pool-*`, never an open conversation) once both the
conversation and Daytona say they have been idle longer than `olderThanMs`; a sandbox
whose conversation is gone goes after a one-hour grace (a subagent's sandbox predates
its record). `startIdleSweep(backend, opts)` runs it a minute after start and every 6 h.
`autoDeleteMinutes` is Daytona's own backstop for a host that is gone. When a
conversation that had a sandbox (a `daytona-sandbox` marker in `convDir`) gets a fresh
one, `ctx.restoreFiles()` (its inputs and latest outputs, from the host's copies) is
uploaded before the kernel is handed over.

**Placement** (`placed.mjs`). `PlacedKernelBackend` routes each conversation to
`cloud` (any `KernelBackend`) or `device` (a `DeviceBackend`: `open`, `destroyFor(userId,
id)`, `shutdown`), by the caller's `ctx.placement`, else the stored one (`lookup`), else
cloud, fixed for the conversation's life. Pool, sweep and drain go to the cloud backend
alone.

## What stays in an app

The harness ships the contract, the placement router, and the cloud backends. An app
keeps what is about its own product: the device backend itself (e.g. a relay over the
app's link to the user's computer), the OS sandbox on that device, its HTTP routes, its
auth and how it mints egress tokens, the tool proxy, where conversations and their
placement are stored (`lookup`, `lastActive`, `isOpen`, `restoreFiles`), and any
startup files that reach app tools (e.g. a `/computer` filesystem shim).

`npm run test:kernel` runs the backend tests against fakes (no Daytona credentials).
