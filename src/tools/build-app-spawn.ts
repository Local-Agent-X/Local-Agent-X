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

// 15min hard cap. Earlier value was 300s, which killed legitimate builds:
// any app whose plan included `npm install` (Express bridge, persisted-store
// SPAs, anything pulling more than a handful of packages) routinely needed
// 4-8 minutes for the CLI to plan + write + install + verify, and the cap
// fired right as the CLI was wrapping up. Symptom from the field:
// "Codex CLI build failed: codex CLI build timed out after 300s" — partial
// artifact on disk, user opens it to a blank page, mistakes timeout for a
// silent provider failure. 15min is loose enough that real failures
// (genuine hangs, auth loops) still terminate; well-formed builds finish
// inside it. Capped here rather than per-call so misuse can't unbounded
// the subprocess.
const BUILD_TIMEOUT_MS = 900_000;

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

/**
 * Validate that a build artifact at `path` is plausibly a complete HTML
 * app, not a partial-write or empty stub. Used in BOTH the success path
 * (exit 0 → make sure we actually built something) and the recovery path
 * (non-zero exit → don't claim "built with warnings" if the file is
 * truncated). Without this, a subprocess that crashed mid-write left a
 * 200-byte half-file and the caller returned "App built (with warnings)"
 * — user opened it to a blank page.
 *
 * Heuristics: file exists, size > minBytes, content contains a closing
 * `</html>` or `</body>` OR the APP_READY marker.
 */
function artifactLooksComplete(indexPath: string, cliOutput: string): boolean {
  if (!existsSync(indexPath)) return false;
  try {
    const { statSync, readFileSync } = require("node:fs");
    const stat = statSync(indexPath);
    if (stat.size < 300) return false; // empty/stub
    // Cheap content check on a tail slice — full <html> docs end with </html>.
    const tail = readFileSync(indexPath, "utf-8").slice(-2000).toLowerCase();
    if (tail.includes("</html>") || tail.includes("</body>")) return true;
    // Some valid-but-unusual outputs are React-ish single-element trees
    // without explicit </body>; accept if the agent printed APP_READY AND
    // the file is non-trivial.
    if (cliOutput.includes("APP_READY") && stat.size > 1500) return true;
    return false;
  } catch { return false; }
}

async function buildWithCodex(input: BuildSpawnInput): Promise<ToolResult> {
  const { prompt, appDir, appUrl, signal, onEvent } = input;
  const indexPath = resolve(appDir, "index.html");
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
    if (artifactLooksComplete(indexPath, output)) {
      return { content: `App built with Codex CLI!\n\nOpen: ${appUrl}\n\n${output.slice(-500)}` };
    }
    return {
      content:
        `Codex CLI exit code 0 but ${existsSync(indexPath) ? "index.html appears truncated/incomplete" : "no index.html written"} in ${appDir}. ` +
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
    // Subprocess failed (non-zero exit, timeout, signal, ENOENT). Only
    // claim "built with warnings" if the artifact actually passes integrity
    // checks — without this gate, a crash mid-write produced a half-file
    // that the agent reported as a successful build, leading the user to
    // a blank page.
    if (artifactLooksComplete(indexPath, "")) {
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
    const indexPath = resolve(appDir, "index.html");
    if (artifactLooksComplete(indexPath, summary)) {
      return { content: `App built with Claude CLI!\n\nOpen: ${appUrl}\n\n${summary.slice(-500)}` };
    }
    return { content: `Claude CLI finished but index.html missing or appears truncated/incomplete.\n${summary.slice(-1000)}`, isError: true };
  } catch (e) {
    const errMsg = (e as Error).message || "unknown";
    if (artifactLooksComplete(resolve(appDir, "index.html"), "")) {
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

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      stopProgress();
      args.signal?.removeEventListener("abort", abortListener);
      if (aborted) {
        rejectP(new Error(`${args.cmd} CLI aborted by canonical-op cancel`));
        return;
      }
      if (code === 0) resolveP(out);
      else {
        // Capture BOTH streams in the error — `errOut || out` used to drop
        // one or the other, which gave us "useless banner only" errors
        // when stderr happened to be empty (race between buffer flush and
        // close event) or "useless 401 stack" when stdout had the real
        // context. exit code + signal are always present in modern
        // failures; surfacing them lets the caller (and the LLM) diagnose
        // auth-401-on-stderr vs prompt-truncated-on-stdin vs OOM-kill
        // without having to reproduce locally.
        const codePart = code != null ? `exit code ${code}` : (signal ? `signal ${signal}` : "no exit info");
        const stderrPart = errOut.trim() ? `\n--- stderr ---\n${errOut.trim().slice(-1500)}` : "";
        const stdoutPart = out.trim() ? `\n--- stdout ---\n${out.trim().slice(-1500)}` : "";
        const detail = (stderrPart + stdoutPart) || " (no output on either stream)";
        rejectP(new Error(`${args.cmd} CLI failed: ${codePart}.${detail}`));
      }
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
