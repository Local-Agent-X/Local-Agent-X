// Shared types for the sandbox subsystem. Kept in their own file so
// sandbox-validate.ts can import SandboxConfig without pulling in
// sandbox.ts (which would create a cycle).

export type SandboxMode = "host" | "docker" | "seatbelt" | "bwrap";

// Which process a kernel-sandbox profile confines. "shell" is the phase-A
// posture (agent shell children: network denied, all sensitive dirs denied).
// "server" is the phase-B posture (the whole Node server: network allowed —
// the in-process egress chokepoint governs destinations — and the dirs the
// server itself owns are exempted; see SERVER_SCOPE_EXEMPT_DIRS).
export type SandboxScope = "shell" | "server";

export interface SandboxConfig {
  mode: SandboxMode;
  image: string;                    // Docker image to use
  workspacePath: string;            // Host path to mount as /workspace
  networkEnabled: boolean;          // Allow network in container (default: false)
  extraMounts: string[];            // Additional read-only mounts
  memoryLimit: string;              // Container memory limit (e.g., "512m")
}
