/**
 * Surgeon selection for self_edit — which coding CLI rewrites LAX's own source,
 * chosen from the user's ACTIVE provider so a user self-edits on the same
 * provider (and subscription) they chat on:
 *
 *   anthropic        → claude   (Claude Code)
 *   codex / openai   → codex    (Codex CLI, `codex exec`)
 *   xai              → grok     (Grok Build CLI)
 *
 * Every OTHER provider (gemini / cerebras / ollama / local / …) falls back to
 * claude for now; the generic non-CLI surgeon — drive LAX's own loop with the
 * active credential, no external CLI — is the planned follow-up.
 *
 * All three run single-shot, auto-approving, headless, editing the worktree
 * cwd in place (no nested worktrees / subagents — the sandbox already owns
 * isolation). The prompt goes via stdin for claude/codex; grok takes it via
 * --prompt-file (its -p wants the prompt inline, which is fragile for large or
 * shell-special prompts — a temp file is robust and cross-platform).
 *
 * This is the one source of truth for the surgeon spawn; both the gated
 * (sandbox) path and the bypass path call runSurgeon().
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { buildSelfEditChildEnv } from "./child-env.js";
import { killProcessTree } from "../process-tree-kill.js";
import { createLogger } from "../logger.js";

const logger = createLogger("self-edit.surgeon");

const SURGEON_TIMEOUT_MS = 10 * 60_000; // source-code surgery can be slow
const MAX_OUTPUT_CHARS = 4000;

export type SurgeonProviderKey = "anthropic" | "codex" | "xai";

interface SurgeonSpec {
  provider: SurgeonProviderKey;
  bin: string;
  baseArgs: string[];
  /** "stdin": prompt piped to the child's stdin. "file": prompt written to a
   *  temp file passed via --prompt-file (grok). */
  promptVia: "stdin" | "file";
  label: string;
  installHint: string;
}

const SPECS: Record<SurgeonProviderKey, SurgeonSpec> = {
  anthropic: {
    provider: "anthropic",
    bin: "claude",
    baseArgs: ["-p", "--model", "claude-opus-4-8", "--permission-mode", "bypassPermissions", "--no-session-persistence", "--output-format", "text"],
    promptVia: "stdin",
    label: "Claude Code",
    installHint: "npm install -g @anthropic-ai/claude-code",
  },
  codex: {
    provider: "codex",
    bin: "codex",
    baseArgs: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--color", "never"],
    promptVia: "stdin",
    label: "Codex CLI",
    installHint: "npm install -g @openai/codex",
  },
  xai: {
    provider: "xai",
    bin: "grok",
    baseArgs: ["--permission-mode", "bypassPermissions", "--no-plan", "--no-subagents", "--output-format", "plain", "--no-auto-update"],
    promptVia: "file",
    label: "Grok Build CLI",
    installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
  },
};

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

/** Map a provider key to the surgeon spec. anthropic + any unmapped provider → claude. */
export function resolveSurgeonSpec(providerArg?: string): SurgeonSpec {
  const provider = (providerArg ?? readActiveProvider()).toLowerCase();
  if (provider === "codex" || provider === "openai") return SPECS.codex;
  if (provider === "xai") return SPECS.xai;
  return SPECS.anthropic;
}

export interface SurgeonRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  label: string;
  bin: string;
}

/**
 * Spawn the resolved surgeon CLI in `cwd`, hand it `prompt`, collect its
 * output. Never rejects — a spawn failure is reported in SurgeonRun.spawnError
 * so callers format one consistent result. Kills the whole process tree on
 * abort/timeout (Windows shell:true wraps the binary in cmd.exe).
 */
export function runSurgeon(cwd: string, prompt: string, signal?: AbortSignal): Promise<SurgeonRun> {
  const spec = resolveSurgeonSpec();
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
