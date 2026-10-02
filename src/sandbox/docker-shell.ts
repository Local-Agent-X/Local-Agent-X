// The Docker sandbox for the bash tool: whether a Docker daemon answers, and
// one throwaway `docker run` per command under the fixed security flags below.
// Callers reach it through the sandbox facade (index.ts).

import { execSync, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../logger.js";
import type { SandboxConfig } from "./types.js";
import { validateSandboxConfig } from "./validate.js";
const logger = createLogger("sandbox");

/**
 * Container Sandbox for Shell Execution
 *
 * When enabled, shell commands run inside a Docker container instead of
 * directly on the host. This is the strongest isolation boundary — even
 * if the LLM is fully compromised, damage is contained to the container.
 *
 * Modes include the guarded default, explicit unconfined host execution,
 * stricter native seatbelt/bwrap profiles, and Docker confinement. This
 * section documents the Docker implementation specifically.
 *
 * The container:
 * - Has workspace mounted read-write at /workspace
 * - Has no network access by default (--network=none)
 * - Drops all capabilities (--cap-drop=ALL)
 * - Has no access to host filesystem outside workspace
 * - Has a 2-minute timeout
 * - Uses a lightweight Alpine image
 */

// Default workspace lives under the OS temp dir, NOT inside the repo.
// validateSandboxConfig rejects any workspacePath inside LAX_REPO_ROOT
// (so the agent can't bind-mount its own source into the container);
// the previous default of "./workspace" resolved to cwd()+"/workspace",
// which tripped that rule and made docker-mode bash always return
// "Sandbox config rejected" with no caller override. The os.tmpdir()
// location is outside the repo, outside ~/.lax (also denied), and is on
// Docker Desktop's default file-sharing paths across platforms.
const DEFAULT_WORKSPACE_PATH = join(tmpdir(), "lax-sandbox-workspace");

const DEFAULT_CONFIG: SandboxConfig = {
  mode: "host",
  image: "node:22-alpine",
  workspacePath: DEFAULT_WORKSPACE_PATH,
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

  const validation = validateSandboxConfig(cfg);
  if (!validation.ok) {
    logger.warn(`[sandbox] Config rejected: ${validation.reason}`);
    return { stdout: "", stderr: `Sandbox config rejected: ${validation.reason}`, exitCode: 1 };
  }

  // docker -v auto-creates a missing source as a root-owned directory;
  // pre-create as the running user so subsequent host-side reads/writes
  // by the agent don't hit a permission wall.
  try { mkdirSync(cfg.workspacePath, { recursive: true }); } catch { /* best-effort */ }

  // ─── Non-negotiable security defaults ─────────────────────────────────────
  // The following docker flags are NOT user-configurable and must not be
  // exposed via SandboxConfig. Adding a knob here (e.g., "allowCapabilities",
  // "writableRoot", "privileged") is what gets sandboxes broken in production.
  // If you think you need to weaken one of these, the answer is almost always
  // "use a different image" or "run on the host" — not "loosen the cage".
  // ──────────────────────────────────────────────────────────────────────────
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
