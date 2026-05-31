/**
 * Surgeon selection for self_edit — which agent rewrites LAX's own source.
 *
 * Resolution order (best available coding agent wins):
 *   1. The ACTIVE provider's own coding CLI, if installed + authed
 *      (anthropic→claude, codex/openai→codex, xai→grok). A user self-edits on
 *      the same provider/subscription they chat on.
 *   2. Otherwise, ANY installed + authed coding CLI (off-provider) — the best
 *      code-specialized agent on the box beats a generic loop.
 *   3. Last resort: the GENERIC surgeon — drive LAX's own agent loop
 *      (runAgentViaCanonical) on the active provider, for providers with no CLI
 *      and no other CLI available (gemini / cerebras / ollama / local / custom).
 *
 * CLI surgeons run single-shot, auto-approving, headless, editing the worktree
 * cwd in place. Prompt via stdin (claude/codex) or --prompt-file (grok). The
 * generic surgeon is dispatched through generic-surgeon.ts (registered runner).
 *
 * One source of truth for the surgeon spawn; both the gated (sandbox) and
 * bypass paths call runSurgeon().
 */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { buildSelfEditChildEnv } from "./child-env.js";
import { runGenericSurgeon } from "./generic-surgeon.js";
import { killProcessTree } from "../process-tree-kill.js";
import { createLogger } from "../logger.js";

const logger = createLogger("self-edit.surgeon");

const SURGEON_TIMEOUT_MS = 10 * 60_000; // source-code surgery can be slow
const MAX_OUTPUT_CHARS = 4000;

export type SurgeonProviderKey = "anthropic" | "codex" | "xai";

export interface CliSurgeonSpec {
  kind: "cli";
  provider: SurgeonProviderKey;
  bin: string;
  baseArgs: string[];
  /** "stdin": prompt piped to the child's stdin. "file": prompt written to a
   *  temp file passed via --prompt-file (grok). */
  promptVia: "stdin" | "file";
  label: string;
  installHint: string;
  /** Auth store path relative to homedir — presence means the CLI is signed in. */
  authPath: string;
  /** Env vars that also satisfy the CLI's auth (API-key installs). */
  authEnv: string[];
}

export interface GenericSurgeonSpec {
  kind: "generic";
  label: string;
}

export type SurgeonSpec = CliSurgeonSpec | GenericSurgeonSpec;

const CLI_SPECS: Record<SurgeonProviderKey, CliSurgeonSpec> = {
  anthropic: {
    kind: "cli", provider: "anthropic", bin: "claude",
    baseArgs: ["-p", "--model", "claude-opus-4-8", "--permission-mode", "bypassPermissions", "--no-session-persistence", "--output-format", "text"],
    promptVia: "stdin", label: "Claude Code", installHint: "npm install -g @anthropic-ai/claude-code",
    authPath: ".claude", authEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  },
  codex: {
    kind: "cli", provider: "codex", bin: "codex",
    baseArgs: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--color", "never"],
    promptVia: "stdin", label: "Codex CLI", installHint: "npm install -g @openai/codex",
    authPath: ".codex/auth.json", authEnv: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  },
  xai: {
    kind: "cli", provider: "xai", bin: "grok",
    baseArgs: ["--permission-mode", "bypassPermissions", "--no-plan", "--no-subagents", "--output-format", "plain", "--no-auto-update"],
    promptVia: "file", label: "Grok Build CLI", installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
    authPath: ".grok/auth.json", authEnv: ["XAI_API_KEY", "GROK_API_KEY", "GROK_DEPLOYMENT_KEY"],
  },
};

// Off-provider fallback order — consulted only after the active provider's own
// CLI. Rough code-capability order; the active provider's CLI always wins first.
const CLI_PRIORITY: SurgeonProviderKey[] = ["anthropic", "codex", "xai"];

/** Read the active chat provider from settings.json — same source build_app uses. */
export function readActiveProvider(): string {
  try {
    const p = join(getLaxDir(), "settings.json");
    if (existsSync(p)) {
      const s = JSON.parse(readFileSync(p, "utf-8")) as { provider?: unknown };
      if (typeof s.provider === "string" && s.provider) return s.provider;
    }
  } catch { /* fall through to default */ }
  return "anthropic";
}

function providerToCliKey(provider: string): SurgeonProviderKey | null {
  if (provider === "anthropic") return "anthropic";
  if (provider === "codex" || provider === "openai") return "codex";
  if (provider === "xai") return "xai";
  return null;
}

/** Pure mapping: the CLI a provider prefers, or null if it has no coding CLI. */
export function cliSpecForProvider(provider: string): CliSurgeonSpec | null {
  const key = providerToCliKey(provider.toLowerCase());
  return key ? CLI_SPECS[key] : null;
}

/** True if the CLI binary resolves AND it's signed in (auth store or env key). */
export function isCliAvailable(spec: CliSurgeonSpec): boolean {
  try {
    execSync(`${spec.bin} --version`, { timeout: 5000, stdio: "pipe", env: buildSelfEditChildEnv(process.env, spec.provider) });
  } catch { return false; }
  if (existsSync(join(homedir(), spec.authPath))) return true;
  return spec.authEnv.some(k => { const v = process.env[k]; return typeof v === "string" && v.length > 0; });
}

export interface ResolveSurgeonDeps {
  provider?: string;
  /** Test seam: override the CLI availability probe. */
  isAvailable?: (spec: CliSurgeonSpec) => boolean;
}

/**
 * Pick the surgeon: active provider's CLI → any available CLI → generic loop.
 */
export function resolveSurgeon(deps: ResolveSurgeonDeps = {}): SurgeonSpec {
  const provider = (deps.provider ?? readActiveProvider()).toLowerCase();
  const isAvailable = deps.isAvailable ?? isCliAvailable;
  const preferredKey = providerToCliKey(provider);
  if (preferredKey && isAvailable(CLI_SPECS[preferredKey])) return CLI_SPECS[preferredKey];
  for (const key of CLI_PRIORITY) {
    if (key === preferredKey) continue;
    if (isAvailable(CLI_SPECS[key])) return CLI_SPECS[key];
  }
  return { kind: "generic", label: "Generic (in-loop)" };
}

export interface SurgeonRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  label: string;
  bin: string;
}

/** Spawn the resolved surgeon and collect its output. Never rejects. */
export async function runSurgeon(cwd: string, prompt: string, signal?: AbortSignal): Promise<SurgeonRun> {
  const spec = resolveSurgeon();
  logger.info(`[surgeon] selected ${spec.label}`);
  if (spec.kind === "generic") {
    const r = await runGenericSurgeon(cwd, prompt, signal);
    return r.ok
      ? { exitCode: 0, stdout: r.output, stderr: "", label: spec.label, bin: "canonical-loop" }
      : { exitCode: 1, stdout: "", stderr: r.output, label: spec.label, bin: "canonical-loop" };
  }
  return runCliSurgeon(spec, cwd, prompt, signal);
}

function runCliSurgeon(spec: CliSurgeonSpec, cwd: string, prompt: string, signal?: AbortSignal): Promise<SurgeonRun> {
  const env = buildSelfEditChildEnv(process.env, spec.provider);
  return new Promise<SurgeonRun>((resolveP) => {
    let tmpDir: string | null = null;
    let args = [...spec.baseArgs];
    if (spec.promptVia === "file") {
      tmpDir = mkdtempSync(join(tmpdir(), "lax-surgeon-"));
      const f = join(tmpDir, "prompt.txt");
      writeFileSync(f, prompt, { mode: 0o600 });
      args = [...args, "--prompt-file", f];
    }
    const cleanup = () => { if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } tmpDir = null; } };

    logger.info(`[surgeon] spawning ${spec.label} (${spec.bin}) in ${cwd}`);
    const proc = spawn(spec.bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env,
    });

    let stdout = "";
    let stderr = "";
    const killTree = () => killProcessTree(proc);
    signal?.addEventListener("abort", killTree);
    const timer = setTimeout(killTree, SURGEON_TIMEOUT_MS);

    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); if (stdout.length > MAX_OUTPUT_CHARS * 3) stdout = stdout.slice(-MAX_OUTPUT_CHARS * 3); });
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", killTree);
      cleanup();
      resolveP({ exitCode: code, stdout: stdout.trim(), stderr, label: spec.label, bin: spec.bin });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", killTree);
      cleanup();
      resolveP({ exitCode: null, stdout: "", stderr: "", spawnError: e.message, label: spec.label, bin: spec.bin });
    });

    if (spec.promptVia === "stdin") proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}

/** Format a SurgeonRun as the surgeon's text output (the shape the gated path expects). */
export function formatSurgeonOutput(run: SurgeonRun): string {
  if (run.spawnError) return `(${run.bin} spawn error: ${run.spawnError})`;
  if (run.exitCode !== 0 && !run.stdout) return `(${run.bin} exited ${run.exitCode}, no output)\n${run.stderr.slice(0, 600)}`;
  return run.stdout.slice(0, MAX_OUTPUT_CHARS);
}
