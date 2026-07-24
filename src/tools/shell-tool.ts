import { spawn } from "node:child_process";
import type { ServerEvent, ToolDefinition } from "../types.js";
import { getSandboxMode, execInSandbox, wrapSpawnForSandbox, sandboxDenialHint } from "../sandbox/index.js";
import { ok, err, blocked, timeout as timeoutResult } from "./result-helpers.js";
import { detectTargetShell, translateForShell, powershellCmdletHint } from "./shell-translate.js";
import { resolveWindowsShell, recordAvSuspectKill, isLikelyAvKill, buildSanitizedEnv } from "./shell-env.js";
import { killProcessGroup } from "../process-tree-kill.js";
import { projectRoot } from "../workspace/paths.js";

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command (bash; on Windows uses Git Bash when installed, else PowerShell). " +
    "BASH IS THE ESCAPE HATCH, NOT THE DEFAULT. Spawning a shell is slower and less reliable than a purpose-built tool. Use these native tools instead whenever possible:\n" +
    "- List files in a directory → `glob` (NOT `ls`/`Get-ChildItem`)\n" +
    "- Read a file's contents → `read` (NOT `cat`/`Get-Content`/`type`)\n" +
    "- Search file contents → `grep` (NOT `grep`/`Select-String`/`findstr`)\n" +
    "- Find files by name → `glob` with a pattern (NOT `find`/`Get-ChildItem -Recurse`)\n" +
    "- Edit a file → `edit` (NOT `sed`/`awk` piping)\n" +
    "- Write a file → `write` (NOT `echo >` / heredoc)\n" +
    "- Install software → `bash` with the OS package manager: `winget install <Id>` (Windows), `brew install <name>` (macOS), `apt install <name>` (Linux). For Ollama on Windows, prefer the .exe from ollama.com — the winget entry skips first-run setup.\n" +
    "- Make HTTP requests → `http_request` (NOT `curl`/`wget`/`Invoke-WebRequest`)\n" +
    "- Open a URL → `browser` (NOT `start`/`open`)\n\n" +
    "Use bash ONLY for: build/test commands the project defines (npm/yarn/pytest/cargo), git operations beyond what tool surface covers, custom user-supplied scripts, OS-level operations no native tool exposes (process listing, env vars, services). " +
    "If you can do it with a native tool above, you MUST. Reaching for bash on something a native tool covers is a behavior bug — it's slower and the native tool returns cleaner, verifiable output.\n\n" +
    "When you DO use bash, prefer ONE focused command over piping multiple together. " +
    "For processing large JSON/CSV files, use `python -c \"import json; ...\"` instead of reading them line by line.\n\n" +
    "PROBE HYGIENE: to check whether a tool is installed, use a targeted probe (`command -v ffmpeg`, `where node`, `Get-Command demucs`) — NEVER dump the environment or credential files (`printenv`, `env`, `set`, `Get-ChildItem env:`, `cat ~/.aws/*`). " +
    "Secret-shaped output is redacted before you see it, so a dump wastes the call; read a specific variable by name only when you actually need it.",
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

    // Browser-open rejection (open/start/xdg-open <url>) now lives in the
    // shared evaluateShellCommand gate (security/shell-policy.ts), which the
    // SecurityLayer runs against every bash call pre-dispatch — so it covers
    // process_start/process_restart too, not just bash. Single source there.
    const sanitizedEnv = buildSanitizedEnv();

    const isWin = process.platform === "win32";
    // Resolve the Windows shell ONCE so translation and spawn agree on it. A
    // real Git Bash runs the model's POSIX commands natively (no rewrite);
    // only the PowerShell fallbacks need the POSIX→PS translation and the
    // `mkdir -p` rewrite. On a Git Bash shell those rewrites would CORRUPT a
    // valid command (`mkdir -p` is real bash), so they are gated on PowerShell.
    const winShell = isWin ? resolveWindowsShell() : null;
    const winUsesPowerShell = winShell !== null && winShell.kind !== "bash";

    let cmd = command;
    if (winUsesPowerShell) {
      cmd = cmd.replace(/\bmkdir\s+-p\s+/g, "New-Item -ItemType Directory -Force -Path ");
      // Rewrite POSIX-isms (`&&`, `||`, `/dev/null`) for PS 5.1 specifically;
      // pwsh 7+ handles `&&`/`||` natively (detectTargetShell returns a no-op
      // target there). Real bash and Mac/Linux never reach this branch.
      cmd = translateForShell(cmd, detectTargetShell(winShell!.path));
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

        const shell = isWin ? winShell!.path : "/bin/bash";
        const shellArgs = winUsesPowerShell
          ? ["-NoProfile", "-Command", cmd]
          : ["-c", cmd];

        // In seatbelt/bwrap mode this rewrites (shell, args) to run under
        // sandbox-exec/bwrap; host/docker modes pass through unchanged. The wrapper
        // is transparent — child.pid, stdio pipes, and the kill path below all
        // operate on the wrapped process exactly as before.
        const spawned = wrapSpawnForSandbox(shell, shellArgs);
        const child = spawn(spawned.cmd, spawned.args, {
          env: sanitizedEnv,
          // _cwd (worktree, set by enforce-policy) wins; otherwise default to the
          // project root — the anchor the file tools and the bash path-gate already
          // assume — so a relative `cat notes.txt` finds project files instead of
          // inheriting the server cwd and failing until the model retries absolute.
          cwd: (args._cwd as string) || projectRoot(),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const killTree = () => { if (child.pid) killProcessGroup(child.pid, child); };

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
          // Antivirus detection — scoped to the PowerShell path only. AV
          // behavior-shields (AVG/Avast/Norton/Defender heuristic) kill
          // powershell.exe mid-execution; a signed Git Bash is not that target,
          // and a fast no-output failure under it is a normal error (127 =
          // command-not-found), not an AV kill. isLikelyAvKill encodes that.
          // On a real PS-path kill we track it and surface a one-time UI banner
          // so the user sees what's wrong before debugging phantom hangs.
          const elapsed = Date.now() - startMs;
          const looksLikeAvKill = isLikelyAvKill({
            isPowerShell: winUsesPowerShell,
            code,
            elapsedMs: elapsed,
            stdoutLen: stdout.length,
            cmdLen: cmd.trim().length,
          });
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
            recovery: "Add the project folder to AV exclusions, OR use http_request / native tools to avoid spawning a shell.",
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
      // If the kernel cage (guarded/seatbelt/bwrap) denied a credential dir, the
      // bare "Operation not permitted" reads as a mystery — name the sandbox + the
      // off switch so the agent reports it right instead of flailing.
      const cageNotice = sandboxDenialHint(sandboxMode, out);
      // A PowerShell cmdlet fired into POSIX bash surfaces only as "command not
      // found" (exit 127) — name the mistake so the agent switches tools instead
      // of re-emitting the same cmdlet (it did this 3× in one session).
      const cmdletNotice = powershellCmdletHint(stderr);
      const notices = [cmdletNotice, cageNotice].filter(Boolean).join("\n");
      return err((notices ? notices + "\n" : "") + (out || `Exit code: ${code}`), {
        exit_code: code,
        duration_ms: durationMs,
        stderr: stderr || undefined,
      });
    } catch (e) {
      return err((e as Error).message, { reason: "spawn failure" });
    }
  },
};
