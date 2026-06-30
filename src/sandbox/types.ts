// Shared types for the sandbox subsystem. Kept in their own file so
// sandbox-validate.ts can import SandboxConfig without pulling in
// sandbox.ts (which would create a cycle).

export type SandboxMode = "host" | "docker" | "seatbelt" | "bwrap";

// Which confinement profile a kernel-sandbox applies.
// - "shell"   — strict shell-child cage: network DENIED + every sensitive dir
//   denied. The opt-in lockdown (mode "seatbelt"/"bwrap").
// - "guarded" — default shell-child cage: network ALLOWED (so npm/git/curl keep
//   working) + sensitive dirs denied EXCEPT the dev-tool exemptions
//   (GUARDED_SCOPE_EXEMPT_DIRS). Backstops the command parser's $VAR/$(...) blind
//   spot at the kernel without breaking the host dev shell.
// - "server"  — phase-B whole-server cage: network allowed (the in-process egress
//   chokepoint governs destinations) + sensitive dirs denied except the ones the
//   server itself owns (SERVER_SCOPE_EXEMPT_DIRS).
export type SandboxScope = "shell" | "guarded" | "server";

export interface SandboxConfig {
  mode: SandboxMode;
  image: string;                    // Docker image to use
  workspacePath: string;            // Host path to mount as /workspace
  networkEnabled: boolean;          // Allow network in container (default: false)
  extraMounts: string[];            // Additional read-only mounts
  memoryLimit: string;              // Container memory limit (e.g., "512m")
}
