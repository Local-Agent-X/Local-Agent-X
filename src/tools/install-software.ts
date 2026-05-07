/**
 * install_software — single-call tool for "install <name>" intent.
 *
 * The agent's job is to express intent ("install ollama"); ours is to
 * encapsulate the OS-specific install dance (which package manager, which
 * flags to avoid UAC prompts, which fallback URL when the package manager
 * is missing or hangs, which command to verify the install landed).
 *
 * Live failure (2026-05-07) that motivated this: agent tried `winget install
 * Ollama.Ollama` on Windows. winget hung on a UAC elevation prompt, the
 * bash tool timed out at 30s, agent retried 11 times → circuit breaker
 * tripped → tried `curl` → blocked by shell-policy → gave up. The agent
 * isn't supposed to know Windows package-manager quirks; it's supposed
 * to call one tool with intent.
 *
 * Strategy progression:
 *   1. `package` — OS-native package manager (winget/brew/apt) with silent
 *      flags + bounded timeout. Streams progress via the bash tool's
 *      tool_progress events.
 *   2. `direct` — direct binary download to ~/Downloads via http_request
 *      (already SSRF-safe). Returns the path; tells the agent to launch
 *      via `start` (Windows) / `open` (Mac) / chmod+x for Linux.
 *   3. `verify` — runs the verify command (e.g., `ollama --version`) to
 *      confirm install landed. Agent calls this last to close the loop.
 *
 * The agent calls these in sequence; each call is bounded and returns a
 * clear next step. No infinite waits, no retry storms.
 */
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";
import { ok, err } from "./result-helpers.js";

interface CatalogEntry {
  /** Display name for messages. */
  display: string;
  /** Windows winget package id (e.g. "Ollama.Ollama"). */
  winget?: string;
  /** macOS Homebrew formula. */
  brew?: string;
  /** Linux apt package name. */
  apt?: string;
  /** Direct .exe / .dmg / .tar.gz fallback URL. Per-platform. */
  directUrl?: { win32?: string; darwin?: string; linux?: string };
  /** Filename to save direct download as. */
  directFilename?: { win32?: string; darwin?: string; linux?: string };
  /** Verify command — should print version + exit 0 if installed. */
  verify: string;
  /** After a direct download, what to tell the user/agent to do next. */
  postDownloadHint?: { win32?: string; darwin?: string; linux?: string };
}

// Curated catalog. Keep small and conservative — entries here represent
// "we've tested this exact path on at least one machine." Add cautiously.
const CATALOG: Record<string, CatalogEntry> = {
  ollama: {
    display: "Ollama",
    winget: "Ollama.Ollama",
    brew: "ollama",
    directUrl: {
      win32: "https://ollama.com/download/OllamaSetup.exe",
      darwin: "https://ollama.com/download/Ollama-darwin.zip",
    },
    directFilename: {
      win32: "OllamaSetup.exe",
      darwin: "Ollama-darwin.zip",
    },
    verify: "ollama --version",
    postDownloadHint: {
      win32: "Run the .exe to launch the installer (UAC prompt expected).",
      darwin: "Unzip and drag Ollama.app to /Applications.",
    },
  },
  node: {
    display: "Node.js LTS",
    winget: "OpenJS.NodeJS.LTS",
    brew: "node",
    apt: "nodejs",
    verify: "node --version",
  },
  python: {
    display: "Python 3",
    winget: "Python.Python.3.12",
    brew: "python@3.12",
    apt: "python3",
    verify: "python --version",
  },
};

function osKey(): "win32" | "darwin" | "linux" | null {
  const p = platform();
  if (p === "win32") return "win32";
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return null;
}

interface ToolProgressEvent { type: "tool_progress"; toolName: string; toolCallId?: string; message: string }

async function runWithTimeout(
  cmd: string,
  cmdArgs: string[],
  timeoutMs: number,
  onProgress?: (line: string) => void,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(cmd, cmdArgs, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let timedOut = false;
    const killTree = (): void => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
        } else { child.kill("SIGKILL"); }
      } catch { /* swallow */ }
    };
    const t = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    let lastEmit = 0;
    const maybeEmit = (): void => {
      if (!onProgress) return;
      const now = Date.now();
      if (now - lastEmit < 500) return;
      lastEmit = now;
      const tail = (stdout + stderr).split(/\r|\n/).filter(s => s.trim()).slice(-1)[0] || "";
      if (tail) onProgress(tail.slice(-200));
    };
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (c: string) => { stdout += c; maybeEmit(); });
    child.stderr.on("data", (c: string) => { stderr += c; maybeEmit(); });
    child.on("exit", (code) => { clearTimeout(t); resolve({ exitCode: code, stdout, stderr, timedOut }); });
    child.on("error", () => { clearTimeout(t); resolve({ exitCode: -1, stdout, stderr, timedOut }); });
  });
}

export const installSoftwareTool: ToolDefinition = {
  name: "install_software",
  description:
    "Install or launch software by name (e.g. 'ollama', 'node', 'python'). Encapsulates OS-specific install logic so you don't have to compose winget/brew/apt + retries + fallbacks yourself. " +
    "Strategies: 'package' tries the OS-native package manager (winget/brew/apt) with silent flags; 'direct' downloads the official binary to ~/Downloads via http_request; 'launch' runs an already-downloaded installer (UAC prompt expected on Windows); 'verify' confirms the install by running the version command. " +
    "Call with strategy='package' first; if it returns needs-fallback, call again with strategy='direct'; if user says 'launch it' or 'run it' or 'install it', call strategy='launch'; finally call strategy='verify' to confirm. " +
    "ALWAYS use this tool for install/launch/run-installer intents — do NOT compose winget/brew/curl in bash directly, and DO NOT call self_edit to launch an installer. self_edit is for SOURCE CODE CHANGES, not running executables. Bash composition hits UAC, source-agreement, shell-policy, and retry-storm failure modes that this tool handles.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Software name (lowercase). Supported: 'ollama', 'node', 'python'. Other names return 'unknown'." },
      strategy: {
        type: "string",
        enum: ["package", "direct", "launch", "verify"],
        description: "package = OS package manager (default first attempt). direct = download official binary to ~/Downloads. launch = run an already-downloaded installer. verify = run version command.",
      },
      timeout_ms: { type: "number", description: "Max wait for the package manager attempt. Default 90000 (90s)." },
    },
    required: ["name"],
  },
  async execute(args) {
    const name = String(args.name || "").toLowerCase().trim();
    const strategy = String(args.strategy || "package");
    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 90_000;
    const onEvent = args._onEvent as ((e: ToolProgressEvent) => void) | undefined;
    const toolCallId = args._toolCallId as string | undefined;
    const emit = (message: string): void => {
      try { onEvent?.({ type: "tool_progress", toolName: "install_software", toolCallId, message }); } catch { /* best-effort */ }
    };

    const entry = CATALOG[name];
    if (!entry) {
      return err(`Unknown software '${name}'. Catalog: ${Object.keys(CATALOG).join(", ")}. To install something not in the catalog, use http_request to fetch the official download URL and a separate write/bash flow.`);
    }
    const os = osKey();
    if (!os) return err(`Unsupported OS: ${platform()}`);

    if (strategy === "verify") {
      emit(`Checking ${entry.display}…`);
      const verifyParts = entry.verify.split(/\s+/);
      const result = await runWithTimeout(verifyParts[0], verifyParts.slice(1), 10_000, emit);
      if (result.exitCode === 0) {
        const version = (result.stdout || result.stderr).trim().split("\n")[0];
        return ok(`${entry.display} installed. ${version}`);
      }
      return err(`${entry.display} not found on PATH. Verify command '${entry.verify}' returned exit ${result.exitCode}. ${result.timedOut ? "(timed out)" : ""}`);
    }

    if (strategy === "package") {
      if (os === "win32" && entry.winget) {
        emit(`winget install ${entry.winget}…`);
        const result = await runWithTimeout(
          "winget",
          ["install", "--id", entry.winget, "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements", "--scope", "user"],
          timeoutMs,
          emit,
        );
        if (result.exitCode === 0) return ok(`${entry.display} installed via winget. Run install_software with strategy='verify' to confirm.`);
        if (result.timedOut) {
          return err(`winget timed out after ${timeoutMs / 1000}s (likely a UAC elevation prompt). Falling back: call install_software with strategy='direct' to download the official installer instead.`);
        }
        return err(`winget exit ${result.exitCode}. ${(result.stderr || result.stdout).trim().slice(-300)}\n\nFallback: call install_software with strategy='direct'.`);
      }
      if (os === "darwin" && entry.brew) {
        emit(`brew install ${entry.brew}…`);
        const result = await runWithTimeout("brew", ["install", entry.brew], timeoutMs, emit);
        if (result.exitCode === 0) return ok(`${entry.display} installed via brew. Run install_software with strategy='verify' to confirm.`);
        if (result.timedOut) return err(`brew timed out after ${timeoutMs / 1000}s. Falling back: call install_software with strategy='direct'.`);
        return err(`brew exit ${result.exitCode}. ${(result.stderr || result.stdout).trim().slice(-300)}\n\nFallback: call install_software with strategy='direct'.`);
      }
      if (os === "linux" && entry.apt) {
        emit(`apt-get install -y ${entry.apt}…`);
        const result = await runWithTimeout("apt-get", ["install", "-y", entry.apt], timeoutMs, emit);
        if (result.exitCode === 0) return ok(`${entry.display} installed via apt. Run install_software with strategy='verify' to confirm.`);
        if (result.timedOut) return err(`apt timed out after ${timeoutMs / 1000}s. Falling back: call install_software with strategy='direct'.`);
        return err(`apt exit ${result.exitCode}. ${(result.stderr || result.stdout).trim().slice(-300)}\n\nFallback: call install_software with strategy='direct'.`);
      }
      return err(`No package-manager path for ${entry.display} on ${os}. Try strategy='direct'.`);
    }

    if (strategy === "direct") {
      const url = entry.directUrl?.[os];
      const filename = entry.directFilename?.[os];
      const hint = entry.postDownloadHint?.[os];
      if (!url || !filename) {
        return err(`No direct download URL for ${entry.display} on ${os}. Catalog entry incomplete.`);
      }
      const downloadPath = join(homedir(), "Downloads", filename);
      if (existsSync(downloadPath)) {
        return ok(
          `${entry.display} installer already downloaded: ${downloadPath}\n\n` +
          `${hint || ""}\n\n` +
          `To run the installer: call install_software again with strategy='launch'. ` +
          `Do NOT call bash, self_edit, or any other tool to launch — use the 'launch' strategy.`,
        );
      }
      // Tell the agent to do the actual download via http_request — this
      // tool encapsulates KNOWLEDGE (URL, filename, post-install hint) but
      // not orchestration. Keeps the tool simple and avoids re-implementing
      // SSRF/audit checks that http_request already has.
      return ok(
        `Direct download required for ${entry.display}.\n` +
        `URL: ${url}\n` +
        `Save to: ${downloadPath}\n` +
        `Use http_request to GET the URL and write the response body to ${downloadPath}.\n` +
        `After download: ${hint || "Run the installer manually."}\n` +
        `Then call install_software with strategy='launch' to run the installer, ` +
        `and strategy='verify' to confirm install.`,
      );
    }

    if (strategy === "launch") {
      const filename = entry.directFilename?.[os];
      if (!filename) {
        return err(`No installer filename known for ${entry.display} on ${os}. Catalog entry incomplete.`);
      }
      const installerPath = join(homedir(), "Downloads", filename);
      if (!existsSync(installerPath)) {
        return err(`Installer not found at ${installerPath}. Call install_software with strategy='direct' first to download.`);
      }
      emit(`Launching ${entry.display} installer…`);
      // Spawn the installer detached so it runs independently of the agent
      // turn (UAC prompts and installer windows can take minutes; we don't
      // want to hold the chat turn open). The installer's GUI is the user's
      // responsibility to drive — we just kick it off.
      try {
        if (os === "win32") {
          // PowerShell Start-Process with -Verb RunAs would force UAC, but
          // most installers handle their own elevation prompt — better to
          // launch normally and let the installer's manifest decide. The
          // installer .exe pops UAC if it needs admin (typical for system
          // installs). For user-scoped installs (Ollama default), no UAC.
          const child = spawn("cmd.exe", ["/c", "start", "", installerPath], {
            detached: true,
            stdio: "ignore",
            windowsHide: false,
          });
          child.unref();
        } else if (os === "darwin") {
          const child = spawn("open", [installerPath], { detached: true, stdio: "ignore" });
          child.unref();
        } else {
          const child = spawn(installerPath, [], { detached: true, stdio: "ignore" });
          child.unref();
        }
        return ok(
          `Launched ${entry.display} installer at ${installerPath}.\n` +
          `The installer window should appear now (UAC prompt may appear first if admin install).\n` +
          `After the user finishes the installer GUI, call install_software with strategy='verify' to confirm install.`,
        );
      } catch (e) {
        return err(`Failed to launch installer: ${(e as Error).message}`);
      }
    }

    return err(`Unknown strategy '${strategy}'. Use 'package', 'direct', 'launch', or 'verify'.`);
  },
};
