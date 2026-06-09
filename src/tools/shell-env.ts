import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import type { ServerEvent } from "../types.js";

// Prefer PowerShell 7+ (pwsh.exe) over the built-in PS 5.1 (powershell.exe)
// when it's on PATH. PS 5.1 treats `&&`/`||` as parser errors; pwsh 7+
// accepts them as pipeline chain operators. Without this detection every
// bash call that chains commands fails on PS 5.1 even when pwsh is
// installed. Live failure 2026-05-14 from another machine: the model
// emitted `ls ... && echo ---EXISTS---` and PS 5.1 rejected it; this
// machine dodged the bug only because the model never happened to chain
// in any of that session's bash calls.
let _winShellCache: string | null = null;
export function getWindowsShell(): string {
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

export function recordAvSuspectKill(
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

// Env scrub for spawned subprocesses. Copies only a known-safe allowlist of
// vars plus any var that's neither a credential-name match nor a high-entropy
// secret-looking value. Shared by bash and the process_* family so both spawn
// paths scrub identically — process_start previously copied the FULL
// process.env, leaking sidecar credentials to every background command.
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
const CREDENTIAL_ENV_PATTERNS = [
  /api[_-]?key/i, /secret/i, /token/i, /password/i, /passwd/i,
  /private[_-]?key/i, /access[_-]?key/i, /auth/i, /credential/i,
  /^AWS_/i, /^AZURE_/i, /^GCP_/i, /^GOOGLE_/i,
  /^OPENAI/i, /^XAI/i, /^LAX_AUTH/i, /^LAX_.*KEY/i,
  /^GITHUB_/i, /^SLACK_/i, /^STRIPE_/i, /^LINEAR_/i,
  /^NPM_TOKEN/i, /^DOCKER_/i, /^CI_/i,
];

/**
 * Build a credential-scrubbed environment for a spawned subprocess. Starts
 * from process.env, keeps only the SAFE_ENV_KEYS allowlist plus vars that
 * don't look like credentials (by name) or secrets (by high-entropy value),
 * then overlays caller-supplied `extra` vars (still NUL-filtered). Pure +
 * side-effect free so both bash and process_* can share it.
 */
export function buildSanitizedEnv(extra?: Record<string, string>): Record<string, string> {
  const sanitizedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (SAFE_ENV_KEYS.has(key)) {
      sanitizedEnv[key] = value;
      continue;
    }
    if (CREDENTIAL_ENV_PATTERNS.some((p) => p.test(key))) continue;
    if (value.includes("\0")) continue;
    if (value.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(value)) continue;
    sanitizedEnv[key] = value;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string" && !v.includes("\0")) sanitizedEnv[k] = v;
    }
  }
  return sanitizedEnv;
}
