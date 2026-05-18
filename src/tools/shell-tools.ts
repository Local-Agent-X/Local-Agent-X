import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import type { ServerEvent, ToolDefinition } from "../types.js";
import { getSandboxMode, execInSandbox } from "../sandbox.js";
import { ok, err, blocked, timeout as timeoutResult } from "./result-helpers.js";

// Prefer PowerShell 7+ (pwsh.exe) over the built-in PS 5.1 (powershell.exe)
// when it's on PATH. PS 5.1 treats `&&`/`||` as parser errors; pwsh 7+
// accepts them as pipeline chain operators. Without this detection every
// bash call that chains commands fails on PS 5.1 even when pwsh is
// installed. Live failure 2026-05-14 from another machine: the model
// emitted `ls ... && echo ---EXISTS---` and PS 5.1 rejected it; this
// machine dodged the bug only because the model never happened to chain
// in any of that session's bash calls.
let _winShellCache: string | null = null;
function getWindowsShell(): string {
  if (_winShellCache) return _winShellCache;
  const pathDirs = (process.env.PATH || "").split(delimiter);
  for (const d of pathDirs) {
    if (!d) continue;
    const candidate = join(d, "pwsh.exe");
    if (existsSync(candidate)) { _winShellCache = candidate; return _winShellCache; }
  }
  _winShellCache = "powershell.exe";
  return _winShellCache;
}

// ── Antivirus interference detector ──────────────────────────────────────
//
// On Windows, behavior-based antivirus (AVG, Avast, Norton, Defender
// heuristic mode) frequently kills `powershell.exe` mid-execution because
// the constantly-varying `-Command` strings our agent runs match the
// "command-line attacker" pattern. Symptoms: command dies in <800ms with
// non-zero/null exit code and no stdout. The user has no way to diagnose
// this — they see "agent is hanging" or "winget timed out" and don't know
// AV is silently killing every shell call.
//
// This detector tracks suspect kills in a sliding 60s window. On the 3rd
// suspect within the window, we emit ONE `av_blocked_warning` ServerEvent
// (the chat-ws layer can render it as a sticky banner with a one-click
// "open AV exclusions" link). The threshold-of-3 gate prevents false
// positives from a single weird command. We only emit ONCE per server
// uptime — repeating the banner is annoying and the user already saw it.
const avSuspectKillTimes: number[] = [];
const AV_WINDOW_MS = 60_000;
const AV_THRESHOLD = 3;
let avBannerEmitted = false;

function recordAvSuspectKill(
  onEvent: ((e: ServerEvent) => void) | undefined,
): void {
  const now = Date.now();
  // Drop kills outside the rolling window
  while (avSuspectKillTimes.length > 0 && now - avSuspectKillTimes[0] > AV_WINDOW_MS) {
    avSuspectKillTimes.shift();
  }
  avSuspectKillTimes.push(now);
  if (avBannerEmitted || avSuspectKillTimes.length < AV_THRESHOLD) return;
  avBannerEmitted = true;
  // Best path the user can whitelist: their LAX project root. We don't
  // know that exactly here, but `cwd` of the server is a safe approximation.
  const projectPath = process.cwd();
  const homePath = homedir();
  const message =
    `Your antivirus is blocking PowerShell commands from this app. Add an exclusion for the project folder to fix it.\n\n` +
    `Path to whitelist: ${projectPath}\n` +
    `(also recommend: ${homePath}\\.lax — your local agent data dir)\n\n` +
    `How to add the exclusion:\n` +
    `• Windows Defender: Settings → Privacy & Security → Windows Security → Virus & threat protection → Manage settings → Add or remove exclusions → Add a folder\n` +
    `• AVG/Avast: Menu → Settings → General → Exceptions → Add Exception → Folder\n` +
    `• Norton: Settings → Antivirus → Scans and Risks → Items to Exclude from Scans → Configure (+ Add Folders)\n\n` +
    `${AV_THRESHOLD} PowerShell commands have been killed mid-execution in the last ${AV_WINDOW_MS / 1000}s — that's the antivirus signature, not a bug in this app.`;
  try {
    onEvent?.({ type: "av_blocked_warning", platform: platform(), projectPath, message } as ServerEvent);
  } catch { /* best-effort */ }
}

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command (PowerShell on Windows, bash elsewhere). " +
    "BASH IS THE ESCAPE HATCH, NOT THE DEFAULT. Spawning a shell is expensive and on Windows triggers antivirus heuristics that kill the process mid-stream. Use these native tools instead whenever possible:\n" +
    "- List files in a directory → `glob` (NOT `ls`/`Get-ChildItem`)\n" +
    "- Read a file's contents → `read` (NOT `cat`/`Get-Content`/`type`)\n" +
    "- Search file contents → `grep` (NOT `grep`/`Select-String`/`findstr`)\n" +
    "- Find files by name → `glob` with a pattern (NOT `find`/`Get-ChildItem -Recurse`)\n" +
    "- Edit a file → `edit` (NOT `sed`/`awk` piping)\n" +
    "- Write a file → `write` (NOT `echo >` / heredoc)\n" +
    "- Install software → `install_software` (NOT `winget`/`brew`/`apt` directly)\n" +
    "- Make HTTP requests → `http_request` (NOT `curl`/`wget`/`Invoke-WebRequest`)\n" +
    "- Open a URL → `browser` (NOT `start`/`open`)\n\n" +
    "Use bash ONLY for: build/test commands the project defines (npm/yarn/pytest/cargo), git operations beyond what tool surface covers, custom user-supplied scripts, OS-level operations no native tool exposes (process listing, env vars, services). " +
    "If you can do it with a native tool above, you MUST. Reaching for bash on something a native tool covers is a behavior bug — antivirus kills will follow and the user will see hangs.\n\n" +
    "When you DO use bash, prefer ONE focused command over piping multiple together. " +
    "For processing large JSON/CSV files, use `python -c \"import json; ...\"` instead of reading them line by line.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 120000 = 2 min)",
      },
    },
    required: ["command"],
  },
  async execute(args, signal?: AbortSignal) {
    const command = String(args.command);
    const timeout = (args.timeout as number) || 120_000;
    if (!args._signal && signal) args._signal = signal;

    const BROWSER_OPEN_CMDS = /\b(start\s+(https?:|www\.|"?https?:)|explorer\s+(https?:|"?https?:)|open\s+(https?:|"?https?:)|xdg-open\s+(https?:|"?https?:)|sensible-browser|wslview\s|powershell.*Start-Process.*https?:|rundll32\s+url\.dll)\b/i;
    if (BROWSER_OPEN_CMDS.test(command)) {
      return err("Cannot open URLs in the system browser — use the browser tool instead.");
    }

    const SAFE_ENV_KEYS = new Set([
      "PATH", "HOME", "USER", "USERNAME", "USERPROFILE", "SHELL",
      "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR", "TEMP", "TMP",
      "NODE_ENV", "NODE_PATH", "NPM_CONFIG_PREFIX",
      "COMPUTERNAME", "HOSTNAME", "OS", "PROCESSOR_ARCHITECTURE",
      "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
      "PROGRAMFILES", "PROGRAMFILES(X86)", "APPDATA", "LOCALAPPDATA",
      "CommonProgramFiles", "CommonProgramFiles(x86)",
      "PWD", "OLDPWD", "SHLVL", "LOGNAME",
      "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR",
      "EDITOR", "VISUAL", "PAGER",
    ]);
    const CREDENTIAL_PATTERNS = [
      /api[_-]?key/i, /secret/i, /token/i, /password/i, /passwd/i,
      /private[_-]?key/i, /access[_-]?key/i, /auth/i, /credential/i,
      /^AWS_/i, /^AZURE_/i, /^GCP_/i, /^GOOGLE_/i,
      /^OPENAI/i, /^XAI/i, /^SAX_AUTH/i, /^SAX_.*KEY/i, /^LAX_AUTH/i, /^LAX_.*KEY/i,
      /^GITHUB_/i, /^SLACK_/i, /^STRIPE_/i, /^LINEAR_/i,
      /^NPM_TOKEN/i, /^DOCKER_/i, /^CI_/i,
    ];

    const sanitizedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
      if (SAFE_ENV_KEYS.has(key)) {
        sanitizedEnv[key] = value;
        continue;
      }
      if (CREDENTIAL_PATTERNS.some((p) => p.test(key))) continue;
      if (value.includes("\0")) continue;
      if (value.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(value)) continue;
      sanitizedEnv[key] = value;
    }

    let cmd = command;
    if (process.platform === "win32") {
      cmd = cmd.replace(/\bmkdir\s+-p\s+/g, "New-Item -ItemType Directory -Force -Path ");
    }

    const sandboxMode = getSandboxMode();
    if (sandboxMode === "docker") {
      const sandboxStart = Date.now();
      const result = execInSandbox(cmd);
      const sandboxDuration = Date.now() - sandboxStart;
      const meta = { exit_code: result.exitCode, duration_ms: sandboxDuration, sandbox: "docker" };
      if (result.exitCode === 0) {
        return ok(
          result.stdout || `[exit 0 in ${sandboxDuration}ms — command succeeded with no captured output]`,
          meta,
        );
      }
      // Surface the constraint so the model reports it correctly to the user
      // instead of concluding it lacks tools. Host-OS commands and network are
      // unavailable inside the container.
      const sandboxNotice =
        "[sandbox: this command ran inside a Docker container (Alpine Linux, --network=none, workspace-only). " +
        "Host-OS commands (ipconfig, Get-NetIPConfiguration, etc.) and network access are not available. " +
        "If host access is required, tell the user to set LAX_SANDBOX=host or toggle Sandbox in Settings.]\n";
      return err(
        `${sandboxNotice}${result.stderr || result.stdout || `Exit code: ${result.exitCode}`}`,
        { ...meta, stderr: result.stderr },
      );
    }

    try {
      const startMs = Date.now();
      // Resolve with structured fields so the call site can populate the
      // tool-result envelope (exit_code, duration_ms, stderr separately).
      // Rejection is reserved for runtime failures (spawn error, abort,
      // timeout) — non-zero exits resolve normally with `code` set.
      type ExecOutcome =
        | { kind: "exit"; code: number | null; stdout: string; stderr: string; durationMs: number; avSuspect: boolean }
        | { kind: "timeout"; durationMs: number; stdout: string; stderr: string }
        | { kind: "abort"; durationMs: number };
      const outcome = await new Promise<ExecOutcome>((resolveP, rejectP) => {
        let settled = false;
        const settle = (fn: typeof resolveP | typeof rejectP, val: ExecOutcome | Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          (fn as (v: unknown) => void)(val);
        };

        const isWin = process.platform === "win32";
        const shell = isWin ? getWindowsShell() : "/bin/bash";
        const shellArgs = isWin ? ["-NoProfile", "-Command", cmd] : ["-c", cmd];

        const child = spawn(shell, shellArgs, {
          env: sanitizedEnv,
          cwd: (args._cwd as string) || undefined,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const killTree = () => {
          try {
            if (isWin && child.pid) {
              spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
            } else if (child.pid) {
              try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
            }
          } catch {}
        };

        const abortSignal = args._signal as AbortSignal | undefined;
        if (abortSignal) {
          if (abortSignal.aborted) { killTree(); settle(resolveP, { kind: "abort", durationMs: 0 }); return; }
          abortSignal.addEventListener("abort", () => {
            killTree();
            settle(resolveP, { kind: "abort", durationMs: Date.now() - startMs });
          }, { once: true });
        }

        const killTimer = setTimeout(() => {
          killTree();
          settle(resolveP, { kind: "timeout", durationMs: Date.now() - startMs, stdout, stderr });
        }, timeout);

        const MAX_OUTPUT = 10 * 1024 * 1024;
        let stdout = "", stderr = "";
        let totalBytes = 0;

        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");

        // Tool-progress streaming. Emits a `tool_progress` ServerEvent at
        // most every 500ms with the latest tail of combined stdout/stderr,
        // so the chat UI can show live output during long-running commands
        // (winget install, npm install, model downloads). Without this the
        // bash card sits silent for the full timeout — agent and user can't
        // distinguish "still working" from "hung." Live failure (2026-05-07):
        // ollama install via winget hung on UAC for 5+ minutes; agent
        // retried 11 times and tripped circuit breaker because there was no
        // progress signal to confirm forward motion.
        // ServerEvent's union already includes tool_progress + av_blocked_warning
        // (see src/types.ts). Use the broader type so this same callback is
        // also compatible with recordAvSuspectKill below, which expects
        // (e: ServerEvent) => void. Narrowing locally to ToolProgressEvent
        // produced a TS2345 mismatch on the recordAvSuspectKill(onEvent) call.
        const onEvent = args._onEvent as ((e: ServerEvent) => void) | undefined;
        const toolCallId = args._toolCallId as string | undefined;
        const PROGRESS_INTERVAL_MS = 500;
        const PROGRESS_TAIL_CHARS = 200;
        let lastProgressEmit = 0;
        let pendingProgress = false;
        const emitProgress = (): void => {
          if (!onEvent) return;
          const now = Date.now();
          if (now - lastProgressEmit < PROGRESS_INTERVAL_MS) {
            if (!pendingProgress) {
              pendingProgress = true;
              setTimeout(emitProgress, PROGRESS_INTERVAL_MS - (now - lastProgressEmit));
            }
            return;
          }
          pendingProgress = false;
          lastProgressEmit = now;
          // Tail of combined output, with carriage-return overwrites collapsed
          // (winget/curl-style "downloading X% \r" updates) so the agent sees
          // the latest line, not a glob of overwrites.
          const combined = (stdout + stderr).slice(-PROGRESS_TAIL_CHARS * 4);
          const lastLine = combined.split(/\r|\n/).filter(s => s.trim()).slice(-1)[0] || combined.trim();
          const message = lastLine.slice(-PROGRESS_TAIL_CHARS);
          if (!message) return;
          try { onEvent({ type: "tool_progress", toolName: "bash", toolCallId, message }); } catch { /* best-effort */ }
        };

        child.stdout.on("data", (chunk: string) => {
          totalBytes += chunk.length;
          if (totalBytes <= MAX_OUTPUT) stdout += chunk;
          emitProgress();
        });
        child.stderr.on("data", (chunk: string) => {
          totalBytes += chunk.length;
          if (totalBytes <= MAX_OUTPUT) stderr += chunk;
          emitProgress();
        });

        child.on("error", (e) => settle(rejectP, e));
        child.on("exit", (code) => {
          // Antivirus detection: on Windows, AV behavior shields (AVG, Avast,
          // Norton, Defender heuristic) kill powershell mid-execution. The
          // signature is consistent: very fast death (< 800ms), exit code
          // non-zero or null (the AV killed it before clean exit), no stdout
          // produced, command was non-trivial. We track per-process via the
          // module-scoped detector (below) and surface a one-time UI banner
          // when the count crosses threshold so the user sees what's wrong
          // BEFORE debugging hangs themselves.
          const elapsed = Date.now() - startMs;
          const looksLikeAvKill =
            isWin &&
            (code === null || (code !== 0 && code !== 1)) &&
            elapsed < 800 &&
            stdout.length === 0 &&
            cmd.trim().length > 8; // skip trivial commands
          if (looksLikeAvKill) {
            recordAvSuspectKill(onEvent);
          }
          settle(resolveP, { kind: "exit", code, stdout, stderr, durationMs: elapsed, avSuspect: looksLikeAvKill });
        });
      });

      // Map structured outcome to a tool-result envelope. metadata carries
      // structured fields (exit_code, duration_ms, stderr, recovery) so the
      // renderer can surface them as a compact header. See src/types.ts.
      if (outcome.kind === "abort") {
        return err("Aborted", { duration_ms: outcome.durationMs });
      }
      if (outcome.kind === "timeout") {
        return timeoutResult(
          `Command timed out after ${timeout / 1000}s.`,
          {
            duration_ms: outcome.durationMs,
            stderr: outcome.stderr || undefined,
            partial_output: (outcome.stdout || outcome.stderr)
              ? (outcome.stdout + (outcome.stderr ? "\n[stderr]\n" + outcome.stderr : "")).slice(-1500)
              : undefined,
            recovery: "Increase the `timeout` arg, OR use process_start for long-running commands so the call returns immediately with a session_id you can poll.",
          },
        );
      }

      const { code, stdout, stderr, durationMs, avSuspect } = outcome;

      if (avSuspect) {
        return blocked(
          `Command was killed externally in ${durationMs}ms with no output — antivirus signature.`,
          {
            exit_code: code,
            duration_ms: durationMs,
            av_suspect: true,
            recovery: "Add the project folder to AV exclusions, OR use http_request / install_software / native tools to avoid spawning a shell.",
          },
        );
      }

      if (code === 0 || code === null) {
        // exit 0 with no captured output is a real, named state — say so.
        // Programs writing only to a TTY (ollama pull, winget install)
        // routinely produce empty stdout. Don't retry; verify another way.
        const content = stdout
          ? (stderr ? stdout + "\n[stderr]\n" + stderr : stdout)
          : `[exit ${code === null ? "?" : code} in ${durationMs}ms — command finished with no captured output. If this was a CLI that writes progress to a TTY (ollama, npm install, winget), verify via filesystem or its REST API rather than re-running.]`;
        return ok(content, {
          exit_code: code,
          duration_ms: durationMs,
          stderr: stderr || undefined,
          stdout_empty: stdout.length === 0,
        });
      }

      const out = [stdout, stderr].filter(Boolean).join("\n");
      return err(out || `Exit code: ${code}`, {
        exit_code: code,
        duration_ms: durationMs,
        stderr: stderr || undefined,
      });
    } catch (e) {
      return err((e as Error).message, { reason: "spawn failure" });
    }
  },
};
