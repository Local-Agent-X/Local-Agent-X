// Shared types for the sandbox subsystem. Kept in their own file so
// sandbox-validate.ts can import SandboxConfig without pulling in
// sandbox.ts (which would create a cycle).

export type SandboxMode = "host" | "docker";

export interface SandboxConfig {
  mode: SandboxMode;
  image: string;                    // Docker image to use
  workspacePath: string;            // Host path to mount as /workspace
  networkEnabled: boolean;          // Allow network in container (default: false)
  extraMounts: string[];            // Additional read-only mounts
  memoryLimit: string;              // Container memory limit (e.g., "512m")
}
