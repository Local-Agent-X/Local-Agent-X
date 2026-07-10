export type MCPExecutionMode = "sandboxed" | "trusted";

export interface MCPBinaryIdentity {
  kind: "binary";
  resolvedPath: string;
  sha256: string;
}

export interface MCPPackageIdentity {
  kind: "package";
  manager: "npx" | "npm" | "pnpm" | "yarn" | "bunx";
  name: string;
  version: string;
}

export interface MCPSignedManifest {
  schemaVersion: 1;
  serverName: string;
  version: string;
  publisher: string;
  keyId?: string;
  command: MCPBinaryIdentity | MCPPackageIdentity;
  configFingerprint: string;
  executionMode: MCPExecutionMode;
  signature: string;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  executionMode?: MCPExecutionMode;
  manifest?: MCPSignedManifest;
}

export interface MCPConfig {
  servers: Record<string, MCPServerConfig>;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const PROTOCOL_VERSION = "2025-11-25";
export const REQUEST_TIMEOUT_MS = 30_000;
