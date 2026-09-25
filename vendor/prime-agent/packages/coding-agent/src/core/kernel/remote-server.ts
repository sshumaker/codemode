// SPIKE: runs INSIDE the sandbox. Wraps prime's real KernelManager — not a reimplementation —
// and exposes it over one WebSocket per session. Jupyter's ZMQ sockets stay on loopback here.
import { existsSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error ws ships no types in this tree
import { WebSocketServer } from "ws";
import { getPackageDir } from "../../config.js";
import type { KernelPythonSkill } from "./bootstrap.js";
import { type HostRequestHandlers, KernelManager } from "./index.js";
// biome-ignore lint/suspicious/noExplicitAny: untyped ws
type WebSocket = any;
import type {
  ClientFrame,
  RemoteStartOptions,
  ServerFrame,
  WireError,
} from "./remote-protocol.js";

const PORT = Number(process.env.KERNEL_SERVER_PORT ?? 8765);
const TOKEN = process.env.KERNEL_SERVER_TOKEN;
const DEFAULT_CWD = process.env.KERNEL_SERVER_CWD ?? process.cwd();

function toWire(error: unknown): WireError {
  if (error instanceof Error)
    return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

// The loop resolves skills against its own checkout; the sandbox has its own copy under
// <packageDir>/dist/skills. Rewrite by the `/skills/<name>/` segment.
function remapSkill(skill: KernelPythonSkill): KernelPythonSkill {
  const root = join(getPackageDir(), "dist", "skills");
  const remap = (p: string) => {
    const i = p.lastIndexOf("/skills/");
    if (i < 0) return p;
    const candidate = join(root, p.slice(i + "/skills/".length));
    return existsSync(candidate) ? candidate : p;
  };
  return {
    ...skill,
    packagePath: remap(skill.packagePath),
    pyprojectPath: remap(skill.pyprojectPath),
  };
}

class Session {
  private kernel?: KernelManager;
  private readonly aborts = new Map<number, AbortController>();
  private readonly hostWaiters = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  private nextReqId = 1;
  private authed = !TOKEN;

  constructor(private readonly ws: WebSocket) {
    ws.on(
      "message",
      (raw: unknown) => void this.onFrame(JSON.parse(String(raw)) as ClientFrame),
    );
    ws.on("close", () => void this.onClose());
  }

  private send(frame: ServerFrame): void {
    if (this.ws.readyState === this.ws.OPEN)
      this.ws.send(JSON.stringify(frame));
  }

  private reply(id: number, started: number, fn: () => Promise<unknown>): void {
    fn().then(
      (value) =>
        this.send({
          t: "result",
          id,
          ok: true,
          value: value ?? null,
          isRunning: this.isRunning,
          serverMs: Date.now() - started,
        }),
      (error) =>
        this.send({
          t: "result",
          id,
          ok: false,
          error: toWire(error),
          isRunning: this.isRunning,
          serverMs: Date.now() - started,
        }),
    );
  }

  private get isRunning(): boolean {
    return this.kernel?.isRunning ?? false;
  }

  private hostHandlers(types: string[]): HostRequestHandlers {
    const handlers: HostRequestHandlers = {};
    for (const type of types) {
      handlers[type] = (payload) =>
        new Promise((resolve, reject) => {
          const reqId = this.nextReqId++;
          this.hostWaiters.set(reqId, { resolve, reject });
          this.send({ t: "host_request", reqId, payload });
        });
    }
    return handlers;
  }

  private build(options: RemoteStartOptions): KernelManager {
    return new KernelManager({
      python: options.python,
      cwd: options.cwd ?? DEFAULT_CWD,
      env: options.env,
      sessionId: options.sessionId,
      username: options.username,
      pythonSkills: options.pythonSkills?.map(remapSkill),
      snapshot: options.snapshot,
      hostHandlers: this.hostHandlers(options.hostHandlerTypes),
    });
  }

  private requireKernel(): KernelManager {
    if (!this.kernel)
      throw new Error(
        "Kernel has been shut down (remote: start was never called)",
      );
    return this.kernel;
  }

  private async onFrame(frame: ClientFrame): Promise<void> {
    const started = Date.now();
    if (!this.authed) {
      if (frame.t === "hello" && frame.token === TOKEN) {
        this.authed = true;
        return;
      }
      this.ws.close(4401, "unauthorized");
      return;
    }
    switch (frame.t) {
      case "hello":
        return;
      case "ping":
        this.send({ t: "pong", id: frame.id });
        return;
      case "start":
        this.kernel ??= this.build(frame.options);
        this.reply(frame.id, started, () =>
          this.requireKernel().start({
            onBootstrapProgress: (message) =>
              this.send({ t: "progress", id: frame.id, message }),
          }),
        );
        return;
      case "execute": {
        const ac = new AbortController();
        this.aborts.set(frame.id, ac);
        this.reply(frame.id, started, async () => {
          try {
            return await this.requireKernel().execute(frame.code, {
              signal: ac.signal,
              maxOutputChars: frame.maxOutputChars,
              internal: frame.internal,
              onStream: (chunk, name) =>
                this.send({ t: "stream", id: frame.id, chunk, name }),
              onLateSentAgentMessage: frame.wantLate
                ? (message) => this.send({ t: "late", id: frame.id, message })
                : undefined,
            });
          } finally {
            this.aborts.delete(frame.id);
          }
        });
        return;
      }
      case "abort":
        this.aborts.get(frame.id)?.abort();
        return;
      case "host_response": {
        const waiter = this.hostWaiters.get(frame.reqId);
        this.hostWaiters.delete(frame.reqId);
        if (!waiter) return;
        if (frame.ok) waiter.resolve(frame.value);
        else waiter.reject(new Error(frame.error));
        return;
      }
      case "call":
        this.reply(frame.id, started, async () => {
          const k = this.requireKernel();
          switch (frame.method) {
            case "restart":
              return k.restart();
            case "shutdown":
              return k.shutdown(frame.args ?? {});
            case "kill":
              return k.kill();
            case "snapshotState":
              return k.snapshotState();
            case "restoreState":
              return k.restoreState();
            case "listNamespaceNames":
              return k.listNamespaceNames();
            case "dispose":
              return k.dispose();
          }
        });
        return;
    }
  }

  private async onClose(): Promise<void> {
    for (const ac of this.aborts.values()) ac.abort();
    for (const w of this.hostWaiters.values())
      w.reject(new Error("loop disconnected"));
    this.hostWaiters.clear();
    await this.kernel?.dispose().catch(() => {});
  }
}

const wss = new WebSocketServer({
  port: PORT,
  host: "0.0.0.0",
  maxPayload: 64 * 1024 * 1024,
});
wss.on("connection", (ws: WebSocket) => new Session(ws));
wss.on("listening", () =>
  process.stdout.write(`kernel-server listening on ${PORT}\n`),
);
