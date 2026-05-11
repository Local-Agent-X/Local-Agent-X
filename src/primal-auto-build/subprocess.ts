/**
 * Claude Code subprocess spawn for the auto-build tool.
 *
 * Each chunk runs in a FRESH `claude -p` session — no context leak between
 * chunks, every chunk reads spec from disk. Same pattern as self_edit's
 * bypass path, but cwd is the target project (not LAX repo), and the prompt
 * carries chunk-specific framing.
 *
 * Returns the agent's final stdout (assumed to be the completion report).
 * No gates here — that's the loop's job after this returns.
 */

import { spawn } from "node:child_process";
import { npmAugmentedEnv } from "../anthropic-client/cli-path.js";

export interface SubprocessOptions {
  /** Working directory the subprocess runs in (the target project root). */
  cwd: string;
  /** Full prompt piped to `claude -p` on stdin. */
  prompt: string;
  /** Wall-clock kill deadline. Default: 30 min — chunks can be slow. */
  timeoutMs?: number;
  /** Cap on captured stdout. Default: 32 KB — enough for a full chunk report. */
  maxOutputChars?: number;
  /** Caller cancellation. Kills the subprocess on abort. */
  signal?: AbortSignal;
  /** Override the model. Default: claude-opus-4-7 (matches self_edit). */
  model?: string;
}

export interface SubprocessResult {
  /** Captured stdout (the agent's report). May be truncated to maxOutputChars. */
  stdout: string;
  /** Captured stderr — for debugging spawn errors, usually empty on success. */
  stderr: string;
  /** Process exit code. null = killed by signal/timeout. */
  exitCode: number | null;
  /** True if the wall-clock timer fired. */
  timedOut: boolean;
  /** Wall-clock duration the subprocess ran for. */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_OUTPUT = 32_000;

export async function spawnClaudeChunkSubprocess(opts: SubprocessOptions): Promise<SubprocessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const model = opts.model || "claude-opus-4-7";
  const startedAt = Date.now();

  return await new Promise<SubprocessResult>((resolveP) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn("claude", [
      "-p",
      "--model", model,
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
      "--output-format", "text",
    ], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: npmAugmentedEnv(),
    });

    const abortListener = () => { try { proc.kill("SIGTERM"); } catch { /* already dead */ } };
    opts.signal?.addEventListener("abort", abortListener);

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    }, timeoutMs);

    proc.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
      if (stdout.length > maxOutput * 3) stdout = stdout.slice(-maxOutput * 3);
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    proc.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortListener);
      resolveP({
        stdout,
        stderr: stderr || `spawn error: ${e.message}`,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortListener);
      resolveP({
        stdout: stdout.slice(-maxOutput),
        stderr,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    proc.stdin?.write(opts.prompt);
    proc.stdin?.end();
  });
}
