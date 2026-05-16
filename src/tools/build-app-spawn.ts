/**
 * App-build CLI spawn — owns the codex / claude subprocess lifecycle for the
 * cli-subprocess strategy of the app_build canonical op.
 *
 * Lifted from the pre-canonical builder-tools.ts (Phase 3 of
 * docs/migration/build-app-to-canonical-op.md). Two changes from the
 * lift-and-shift baseline:
 *
 *   1. Accepts an AbortSignal. On abort the subprocess tree dies via
 *      killProcessTree (Windows shell:true wraps the real binary in cmd.exe,
 *      so plain proc.kill leaves an orphan — same pattern as
 *      self-edit-sandbox-gates.ts). Closes gap A from Phase 2 where the
 *      adapter's abort flag flipped but the subprocess kept running.
 *   2. Lives outside `src/canonical-loop/` so the adapter-sandbox audit
 *      (test/canonical-loop-11-boundary-audit.test.ts) stays clean — the
 *      adapter calls through this util by function call, never imports
 *      `node:child_process` itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { killProcessTree } from "../process-tree-kill.js";
import type { ToolResult } from "../types.js";

const BUILD_TIMEOUT_MS = 300_000;

export interface BuildSpawnInput {
  provider: "codex" | "anthropic";
  prompt: string;
  appDir: string;
  appUrl: string;
  signal?: AbortSignal;
  onEvent?: (e: { type: string; [k: string]: unknown }) => void;
}

export async function runCliBuild(input: BuildSpawnInput): Promise<ToolResult> {
  if (input.provider === "codex") return buildWithCodex(input);
  return buildWithClaude(input);
}

async function buildWithCodex(input: BuildSpawnInput): Promise<ToolResult> {
  const { prompt, appDir, appUrl, signal, onEvent } = input;
  try {
    const stdout = await runSpawn({
      cmd: "codex",
      args: [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--color", "never",
      ],
      cwd: appDir,
      stdin: prompt,
      env: { ...process.env, NO_COLOR: "1" },
      signal,
      onEvent,
    });
    const output = stdout.trim();
    if (output.includes("APP_READY") || existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built with Codex CLI!\n\nOpen: ${appUrl}\n\n${output.slice(-500)}` };
    }
    return {
      content:
        `Codex CLI exit code 0 but no index.html in ${appDir}. ` +
        `Most likely the ChatGPT subscription truncated the build mid-write ` +
        `(its tool-output limit is smaller than what build_app needs for a ` +
        `full single-file app). Options: (1) ask the user to switch the chat ` +
        `provider to Anthropic and retry, (2) write the file directly with ` +
        `the \`write\` tool instead of build_app, or (3) keep the prompt ` +
        `short enough that the response fits inside the subscription cap.\n\n` +
        `Tail of CLI output:\n${output.slice(-1000)}`,
      isError: true,
    };
  } catch (e) {
    const errMsg = (e as Error).message || "unknown";
    if (existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built (with warnings)!\n\nOpen: ${appUrl}\n\n${errMsg.slice(0, 300)}` };
    }
    return { content: `Codex CLI build failed: ${errMsg.slice(0, 500)}`, isError: true };
  }
}

async function buildWithClaude(input: BuildSpawnInput): Promise<ToolResult> {
  const { prompt, appDir, appUrl, signal, onEvent } = input;
  try {
    const finalText = { value: "" };
    const claudeParser = (line: string): string | null => parseClaudeStreamLine(line, finalText);
    const stdout = await runSpawn({
      cmd: "claude",
      args: [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--max-turns", "25",
        "--model", "claude-opus-4-7",
        // claude CLI prompts interactively for Write approval by default.
        // The pipe-stdin invocation has no UI to surface the prompt, so the
        // CLI returns without writing and the build fails with "I need
        // write permission" in the assistant output. bypassPermissions
        // disables the interactive gate — safe here because the subprocess
        // is sandboxed to the appDir cwd and only has Write/Edit/Read/Bash.
        "--permission-mode", "bypassPermissions",
        "--tools", "Write,Edit,Read,Bash",
        "--disallowedTools", "WebFetch,WebSearch",
      ],
      cwd: appDir,
      stdin: prompt,
      signal,
      onEvent,
      parseLine: claudeParser,
    });
    const summary = finalText.value || stdout.trim();
    if (summary.includes("APP_READY") || existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built with Claude CLI!\n\nOpen: ${appUrl}\n\n${summary.slice(-500)}` };
    }
    return { content: `Claude CLI finished but index.html not found.\n${summary.slice(-1000)}`, isError: true };
  } catch (e) {
    const errMsg = (e as Error).message || "unknown";
    if (existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built (with warnings)!\n\nOpen: ${appUrl}\n\n${errMsg.slice(0, 300)}` };
    }
    return { content: `Claude CLI build failed: ${errMsg.slice(0, 500)}`, isError: true };
  }
}

interface SpawnArgs {
  cmd: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (e: { type: string; [k: string]: unknown }) => void;
  parseLine?: (line: string) => string | null;
}

function runSpawn(args: SpawnArgs): Promise<string> {
  return new Promise<string>((resolveP, rejectP) => {
    const proc = spawn(args.cmd, args.args, {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: args.env ?? process.env,
    });
    proc.stdin?.write(args.stdin);
    proc.stdin?.end();
    let out = "", errOut = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { errOut += d.toString(); });
    const stopProgress = streamProgress(proc, "build_app", args.onEvent, 750, args.parseLine);

    let aborted = false;
    const abortListener = (): void => {
      aborted = true;
      killProcessTree(proc);
    };
    if (args.signal) {
      if (args.signal.aborted) abortListener();
      else args.signal.addEventListener("abort", abortListener);
    }

    const timer = setTimeout(() => {
      killProcessTree(proc);
      rejectP(new Error(`${args.cmd} CLI build timed out after ${Math.round(BUILD_TIMEOUT_MS / 1000)}s`));
    }, BUILD_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      stopProgress();
      args.signal?.removeEventListener("abort", abortListener);
      if (aborted) {
        rejectP(new Error(`${args.cmd} CLI aborted by canonical-op cancel`));
        return;
      }
      if (code === 0) resolveP(out);
      else rejectP(new Error(errOut || out || `${args.cmd} CLI exit code ${code}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      stopProgress();
      args.signal?.removeEventListener("abort", abortListener);
      const installHint = args.cmd === "codex"
        ? "Install with: npm install -g @openai/codex"
        : "Install with: npm install -g @anthropic-ai/claude-code";
      rejectP(new Error(`${args.cmd} CLI not available: ${err.message}. ${installHint}`));
    });
  });
}

function streamProgress(
  proc: ChildProcess,
  toolName: string,
  onEvent: ((e: { type: string; [k: string]: unknown }) => void) | undefined,
  minIntervalMs: number,
  parseLine?: (line: string) => string | null,
): () => void {
  if (!onEvent) return () => { /* no-op */ };
  let lastLine = "";
  let lastEmit = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const tryEmit = (force: boolean): void => {
    if (!lastLine) return;
    const now = Date.now();
    const gap = now - lastEmit;
    if (force || gap >= minIntervalMs) {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      lastEmit = now;
      try { onEvent({ type: "tool_progress", toolName, message: lastLine.slice(0, 160) }); } catch { /* swallow */ }
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(() => { pendingTimer = null; tryEmit(true); }, minIntervalMs - gap);
    }
  };
  const onChunk = (d: Buffer): void => {
    const text = d.toString();
    for (const raw of text.split(/\r?\n/)) {
      const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
      if (stripped.length === 0) continue;
      const transformed = parseLine ? parseLine(stripped) : stripped;
      if (transformed === null) continue;
      if (transformed.length < 3) continue;
      lastLine = transformed;
    }
    tryEmit(false);
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);
  return () => {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    tryEmit(true);
  };
}

function parseClaudeStreamLine(line: string, finalTextRef: { value: string }): string | null {
  let evt: { type?: string; subtype?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string }> }; result?: string };
  try { evt = JSON.parse(line); } catch { return line.slice(0, 200); }
  if (evt.type === "system" && evt.subtype === "init") return "Claude CLI starting…";
  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const t = block.text.trim();
        finalTextRef.value = t;
        return t.slice(0, 200);
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        return `Calling ${block.name}…`;
      }
    }
  }
  if (evt.type === "result" && typeof evt.result === "string") {
    finalTextRef.value = evt.result;
    return null;
  }
  return null;
}
