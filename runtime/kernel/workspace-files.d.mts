import type { WorkspaceFiles } from "./backend.mjs";

export declare class WorkspaceFileError extends Error {}

/** Workspace files on this machine's disk: resolved paths must stay inside `workDir/<inputs|outputs>`. */
export declare class HostWorkspaceFiles implements WorkspaceFiles {
  constructor(workDir: string);
  readFile(relPath: string, maxBytes: number): Promise<Buffer>;
  writeFile(relPath: string, data: Buffer): Promise<void>;
}

/** The slice of a sandbox provider (runtime/daytona/provider.mjs) a sandbox's workspace files need. */
export interface SandboxFileApi {
  listTree(
    conversationId: string,
    dir?: string,
  ): Promise<{ path: string; size: number }[]>;
  readFile(conversationId: string, path: string): Promise<Buffer>;
  uploadFile(
    conversationId: string,
    path: string,
    data: Buffer,
  ): Promise<string>;
}

/** Workspace files inside a sandbox, read and written through its provider once `ready` settles. */
export declare class SandboxWorkspaceFiles implements WorkspaceFiles {
  constructor(
    provider: SandboxFileApi,
    conversationId: string,
    ready?: Promise<void>,
  );
  readFile(relPath: string, maxBytes: number): Promise<Buffer>;
  writeFile(relPath: string, data: Buffer): Promise<void>;
}
