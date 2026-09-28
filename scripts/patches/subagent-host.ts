/**
 * harness: the loop-side half of `spawn()` over the kernel↔host channel.
 *
 * `runtime/subagents.py` has two transports. The file transport writes a request
 * into the job directory for `runtime/subagent_broker.py` to start; that needs the
 * broker to share the kernel's filesystem, which a remote (Daytona) kernel does not.
 * The host transport sends the same request as a kernel host request instead — the
 * channel prime already runs for every kernel, local or remote — and this handler,
 * in the loop's process, forwards it to the broker named by
 * HARNESS_SUBAGENT_BROKER_URL with the loop's egress token.
 *
 * Two things only the loop knows travel with every request: the parent's model and
 * thinking level. The broker defaults a child to them, so parent and child run the
 * same model unless the caller explicitly asks for another one.
 *
 * Off unless HARNESS_SUBAGENTS=1 and a broker URL is set: with no handler, a kernel
 * host request of this type is refused as "not available in this session".
 */
import type { HostRequestHandlers } from "./kernel/index.js";

export const SUBAGENT_HOST_REQUEST = "harness.subagent";

const SUBAGENT_OPS = new Set(["spawn", "status", "list", "kill", "wait"]);

export interface SubagentParentInfo {
  model?: string;
  thinking?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function harnessSubagentHostHandlers(
  parent: () => SubagentParentInfo,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): HostRequestHandlers {
  if (env.HARNESS_SUBAGENTS !== "1") return {};
  const broker = env.HARNESS_SUBAGENT_BROKER_URL;
  if (!broker) return {};
  const timeoutMs = Number(env.HARNESS_SUBAGENT_BROKER_TIMEOUT_MS ?? 30_000);
  return {
    [SUBAGENT_HOST_REQUEST]: async (payload) => {
      const { type: _type, cellSourceCode: _cell, ...body } = payload;
      const op = typeof body.op === "string" ? body.op : "";
      if (!SUBAGENT_OPS.has(op))
        throw new Error(`unknown subagent operation "${op}"`);
      const res = await fetchImpl(`${broker.replace(/\/+$/, "")}/${op}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-egress-token": env.HARNESS_EGRESS_TOKEN ?? "",
        },
        body: JSON.stringify({
          ...body,
          parent: {
            ...parent(),
            depth: Number(env.HARNESS_SUBAGENT_DEPTH ?? "0") || 0,
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let reply: Record<string, unknown>;
      try {
        reply = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(
          `the subagent broker answered ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      if (!res.ok || reply.ok === false) {
        const error = reply.error;
        throw new Error(
          typeof error === "string"
            ? error
            : typeof (error as { message?: unknown })?.message === "string"
              ? (error as { message: string }).message
              : `the subagent broker answered ${res.status}`,
        );
      }
      return reply;
    },
  };
}
