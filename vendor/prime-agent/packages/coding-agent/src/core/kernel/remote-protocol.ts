// SPIKE: wire protocol between RemoteKernelManager (loop side) and remote-server (sandbox side).
// One WebSocket == one KernelManager. Every request carries an `id`; the server answers with
// exactly one `result` frame for it, preceded by any number of `stream` / `late` / `progress`
// frames with the same id. Host requests flow the other way, keyed by `reqId`.
import type {
  ExecuteResult,
  KernelSentAgentMessage,
  KernelSnapshotConfig,
} from "./index.js";
import type { KernelPythonSkill } from "./bootstrap.js";

export interface RemoteStartOptions {
  python?: string;
  cwd?: string;
  env?: Record<string, string>;
  sessionId?: string;
  username?: string;
  pythonSkills?: readonly KernelPythonSkill[];
  snapshot?: KernelSnapshotConfig;
  /** Names of host handlers the loop registered; the server proxies each back over the socket. */
  hostHandlerTypes: string[];
}

export type ClientFrame =
  | { t: "hello"; token?: string }
  | { t: "start"; id: number; options: RemoteStartOptions }
  | {
      t: "execute";
      id: number;
      code: string;
      maxOutputChars?: number;
      internal?: boolean;
      wantLate?: boolean;
    }
  | { t: "abort"; id: number }
  | {
      t: "call";
      id: number;
      method:
        | "restart"
        | "shutdown"
        | "kill"
        | "snapshotState"
        | "restoreState"
        | "listNamespaceNames"
        | "dispose";
      args?: { snapshot?: boolean };
    }
  | {
      t: "host_response";
      reqId: number;
      ok: true;
      value: Record<string, unknown>;
    }
  | { t: "host_response"; reqId: number; ok: false; error: string }
  | { t: "ping"; id: number };

export interface WireError {
  name: string;
  message: string;
}

export type ServerFrame =
  | {
      t: "result";
      id: number;
      ok: true;
      value: unknown;
      isRunning: boolean;
      serverMs: number;
    }
  | {
      t: "result";
      id: number;
      ok: false;
      error: WireError;
      isRunning: boolean;
      serverMs: number;
    }
  | { t: "stream"; id: number; chunk: string; name: "stdout" | "stderr" }
  | { t: "late"; id: number; message: KernelSentAgentMessage }
  | { t: "progress"; id: number; message: string }
  | { t: "host_request"; reqId: number; payload: Record<string, unknown> }
  | { t: "pong"; id: number };

export type RemoteExecuteResult = ExecuteResult;
