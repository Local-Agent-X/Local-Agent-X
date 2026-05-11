/**
 * Code-CLI subprocess spawn for the auto-build tool.
 *
 * Each chunk runs in a FRESH coding-CLI session — `claude -p` or `codex
 * exec` depending on the user's selected provider. No context leak
 * between chunks, every chunk reads spec from disk. Same pattern as
 * self_edit's bypass path, but cwd is the target project (not LAX
 * repo), and the prompt carries chunk-specific framing.
 *
 * Returns the agent's final stdout (assumed to be the completion report).
 * No gates here — that's the loop's job after this returns.
 *
 * Provider routing:
 *   - "anthropic" (default) → `claude -p` with --permission-mode bypassPermissions
 *   - "codex"   → `codex exec` with comparable flags
 *   - "openai"  → same binary as codex (codex CLI is the OpenAI ChatGPT-on-Codex shape)
 */

import { spawn } from "node:child_process";
import { npmAugmentedEnv } from "../anthropic-client/cli-path.js";

export type WorkerProvider = "anthropic" | "codex" | "openai" | "auto";

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
  /** Override the model. Default depends on provider — claude-opus-4-7 for anthropic, gpt-5.5 for codex. */
  model?: string;
  /** Which CLI to spawn. Default "auto" → resolves from user's selected provider at call time. */
  provider?: WorkerProvider;
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
  const startedAt = Date.now();

  const resolved = await resolveProviderSpec(opts.provider, opts.model);

  return await new Promise<SubprocessResult>((resolveP) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(resolved.bin, resolved.args, {
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

interface ResolvedSpec {
  bin: string;
  args: string[];
  /** Which provider got chosen — surfaced so the caller can log it. */
  provider: WorkerProvider;
}

/**
 * Pick the right CLI binary + args for the user's active provider.
 *
 * Default "auto" reads the user's selected provider from ~/.lax/settings.json
 * (same source the chat UI uses). If that's unset or unreadable, falls
 * back to Anthropic / Claude Code — same default the chat router uses.
 *
 * For Codex, we map gpt-* models to `codex exec`. Claude maps to `claude -p`.
 * Both spawn with explicit non-interactive flags and bypass-permissions —
 * the chunk runs inside a per-project directory, the loop owns the git
 * boundary, and the subprocess shouldn't pause for human input.
 */
async function resolveProviderSpec(provider: WorkerProvider | undefined, modelOverride: string | undefined): Promise<ResolvedSpec> {
  let effective: WorkerProvider = provider || "auto";
  if (effective === "auto") {
    effective = (await readSelectedProvider()) || "anthropic";
  }

  if (effective === "codex" || effective === "openai") {
    const model = modelOverride || "gpt-5.5";
    return {
      bin: "codex",
      args: ["exec", "--model", model, "--full-auto", "-"],
      provider: effective,
    };
  }

  // Anthropic (default).
  const model = modelOverride || "claude-opus-4-7";
  return {
    bin: "claude",
    args: [
      "-p",
      "--model", model,
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
      "--output-format", "text",
    ],
    provider: "anthropic",
  };
}

async function readSelectedProvider(): Promise<WorkerProvider | null> {
  try {
    const { existsSync, readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const p = join(homedir(), ".lax", "settings.json");
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, "utf-8")) as { provider?: string };
    const v = (s.provider || "").toLowerCase();
    if (v === "anthropic" || v === "codex" || v === "openai") return v as WorkerProvider;
    return null;
  } catch {
    return null;
  }
}
