export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  /**
   * Kernel-cage the child process (guarded scope: credential-path deny,
   * network kept). Default (absent/true) = caged where a backend is usable.
   * Set false to opt this one server out — e.g. a local server that
   * legitimately needs to read a denied path like ~/.aws.
   */
  sandbox?: boolean;
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
