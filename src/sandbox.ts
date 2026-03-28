import { execSync, execFileSync } from "node:child_process";

/**
 * Container Sandbox for Shell Execution
 *
 * When enabled, shell commands run inside a Docker container instead of
 * directly on the host. This is the strongest isolation boundary — even
 * if the LLM is fully compromised, damage is contained to the container.
 *
 * Modes:
 * - "host" (default): Commands run directly on host. Fast but high blast radius.
 * - "docker": Commands run in a Docker container with limited capabilities.
 *
 * The container:
 * - Has workspace mounted read-write at /workspace
 * - Has no network access by default (--network=none)
 * - Drops all capabilities (--cap-drop=ALL)
 * - Has no access to host filesystem outside workspace
 * - Has a 2-minute timeout
 * - Uses a lightweight Alpine image
 */

export type SandboxMode = "host" | "docker";

interface SandboxConfig {
  mode: SandboxMode;
  image: string;                    // Docker image to use
  workspacePath: string;            // Host path to mount as /workspace
  networkEnabled: boolean;          // Allow network in container (default: false)
  extraMounts: string[];            // Additional read-only mounts
  memoryLimit: string;              // Container memory limit (e.g., "512m")
}

const DEFAULT_CONFIG: SandboxConfig = {
  mode: "host",
  image: "node:22-alpine",
  workspacePath: "./workspace",
  networkEnabled: false,
  extraMounts: [],
  memoryLimit: "512m",
};

/** Check if Docker is available */
export function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a command in a Docker container sandbox.
 * Returns { stdout, stderr, exitCode }.
 */
export function execInSandbox(
  command: string,
  config: Partial<SandboxConfig> = {}
): { stdout: string; stderr: string; exitCode: number } {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Build docker run command
  const args: string[] = [
    "docker", "run",
    "--rm",                              // Remove container after execution
    "--cap-drop=ALL",                    // Drop all Linux capabilities
    "--security-opt=no-new-privileges",  // Prevent privilege escalation
    `--memory=${cfg.memoryLimit}`,       // Memory limit
    "--pids-limit=100",                  // Process limit
    "--read-only",                       // Read-only root filesystem
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m", // Writable /tmp
  ];

  // Network
  if (!cfg.networkEnabled) {
    args.push("--network=none");
  }

  // Mount workspace
  args.push(`-v`, `${cfg.workspacePath}:/workspace:rw`);
  args.push(`-w`, `/workspace`);

  // Extra read-only mounts
  for (const mount of cfg.extraMounts) {
    args.push(`-v`, `${mount}:ro`);
  }

  // Image and command
  args.push(cfg.image);
  args.push("/bin/sh", "-c", command);

  try {
    const [cmd, ...cmdArgs] = args;
    const stdout = execFileSync(cmd, cmdArgs, {
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; status?: number; message: string };
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || error.message,
      exitCode: error.status || 1,
    };
  }
}

/**
 * Get the current sandbox configuration.
 * Reads from SAX_SANDBOX env var or config.
 */
export function getSandboxMode(): SandboxMode {
  const envMode = process.env.SAX_SANDBOX;
  // Explicit override
  if (envMode === "host") return "host";
  if (envMode === "docker") {
    if (!isDockerAvailable()) {
      console.warn("[sandbox] SAX_SANDBOX=docker but Docker not available. Falling back to host.");
      return "host";
    }
    return "docker";
  }
  // Auto-detect: prefer Docker if available (secure by default)
  if (isDockerAvailable()) {
    console.log("[sandbox] Docker detected — using container sandbox by default. Set SAX_SANDBOX=host to disable.");
    return "docker";
  }
  return "host";
}
