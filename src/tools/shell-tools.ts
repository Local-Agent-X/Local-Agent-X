import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";
import { getSandboxMode, execInSandbox } from "../sandbox.js";
import { ok, err } from "./result-helpers.js";

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    process.platform === "win32"
      ? "Execute a PowerShell command. Use Get-ChildItem, Get-Content, Select-Object, etc. For processing large JSON/CSV files, use: python -c \"import json; ...\" instead of reading them line by line."
      : "Execute a bash command. For processing large JSON/CSV files, use: python -c \"import json; ...\" instead of reading them line by line.",
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
      const result = execInSandbox(cmd);
      if (result.exitCode === 0) {
        return ok(result.stdout || "[exit 0 — command succeeded with no output]");
      }
      return err(result.stderr || result.stdout || `Exit code: ${result.exitCode}`);
    }

    try {
      const output = await new Promise<string>((resolveP, rejectP) => {
        let settled = false;
        const settle = (fn: typeof resolveP | typeof rejectP, val: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          fn(val);
        };

        const isWin = process.platform === "win32";
        const shell = isWin ? "powershell.exe" : "/bin/bash";
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
          if (abortSignal.aborted) { killTree(); settle(rejectP, "Aborted"); return; }
          abortSignal.addEventListener("abort", () => { killTree(); settle(rejectP, "Aborted by signal"); }, { once: true });
        }

        const killTimer = setTimeout(() => {
          killTree();
          settle(rejectP, `Command timed out after ${timeout / 1000}s`);
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
        type ToolProgressEvent = { type: "tool_progress"; toolName: string; toolCallId?: string; message: string };
        const onEvent = args._onEvent as ((e: ToolProgressEvent) => void) | undefined;
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

        child.on("error", (e) => settle(rejectP, e.message));
        child.on("exit", (code) => {
          if (code === 0 || code === null) {
            const result = stdout
              ? (stderr ? stdout + "\n[stderr]\n" + stderr : stdout)
              : "[exit 0 — command succeeded with no output]";
            settle(resolveP, result);
          } else {
            const out = [stdout, stderr].filter(Boolean).join("\n");
            settle(rejectP, out || `Exit code: ${code}`);
          }
        });
      });
      return ok(output);
    } catch (e) {
      return err((e as Error).message);
    }
  },
};
