import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { delimiter, join, sep } from "node:path";
import type { ServerEvent } from "../types.js";

// ── Windows shell resolution ──────────────────────────────────────────────
//
// The `bash` tool and process_* spawn a shell per call. On Windows the model
// emits POSIX-style commands (pipes to grep/head, `git clone`, `&&`), so the
// RELIABLE shell is a real POSIX bash — Git for Windows ships one. Routing the
// model's bash through PowerShell + a partial POSIX→PS translation is the
// "works sometimes" failure mode: simple commands translate, anything with a
// pipe to grep/head, a heredoc, or `git clone` does not. Live failure
// (2026-06-27): an ingest session's `git clone` hit `/dev/tty: No such device`
// and a literal `bash` resolved to the WSL launcher (System32\bash.exe →
// "execvpe(/bin/bash) failed") because the tool ran the command through
// PowerShell and there was no real bash selected.
//
// Resolution order: real Git Bash → pwsh 7+ → Windows PowerShell 5.1. Each is
// existence-validated (the old code returned the bare string "powershell.exe"
// with NO check, so a missing shell surfaced as an opaque spawn error). The WSL
// launcher (System32\bash.exe / WindowsApps stubs) is explicitly EXCLUDED — it
// is not a usable POSIX shell without a distro and is exactly what broke above.
export type WindowsShellKind = "bash" | "pwsh" | "powershell";
export interface WindowsShell {
  kind: WindowsShellKind;
  path: string;
}

let _winShellResolved: WindowsShell | null = null;

function findOnPath(exe: string): string | null {
  for (const d of (process.env.PATH || "").split(delimiter)) {
    if (!d) continue;
    const candidate = join(d, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// `C:\Windows\System32\bash.exe` and the WindowsApps store stubs are the WSL
// entrypoint — they throw "execvpe(/bin/bash) failed" when no distro is
// installed, so they must never be selected as a POSIX shell.
function isWslLauncher(p: string): boolean {
  const low = p.toLowerCase().replace(/\//g, "\\");
  return low.includes("\\system32\\") || low.includes("\\windowsapps\\");
}

// A real Git-for-Windows bash, validated to exist and to not be the WSL
// launcher. Probed from git-on-PATH first (the common case), then the standard
// install roots, then a PATH scan.
function findGitBash(): string | null {
  const candidates: string[] = [];
  const gitExe = findOnPath("git.exe");
  if (gitExe && !isWslLauncher(gitExe)) {
    // <Git>\cmd\git.exe or <Git>\bin\git.exe → <Git>
    const gitRoot = join(gitExe, "..", "..");
    candidates.push(join(gitRoot, "bin", "bash.exe"), join(gitRoot, "usr", "bin", "bash.exe"));
  }
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pfx86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA;
  candidates.push(
    join(pf, "Git", "bin", "bash.exe"),
    join(pf, "Git", "usr", "bin", "bash.exe"),
    join(pfx86, "Git", "bin", "bash.exe"),
  );
  if (local) candidates.push(join(local, "Programs", "Git", "bin", "bash.exe"));
  for (const d of (process.env.PATH || "").split(delimiter)) {
    if (d) candidates.push(join(d, "bash.exe"));
  }
  for (const c of candidates) {
    if (!isWslLauncher(c) && existsSync(c)) return c;
  }
  return null;
}

export function resolveWindowsShell(): WindowsShell {
  if (_winShellResolved) return _winShellResolved;
  const gitBash = findGitBash();
  if (gitBash) return (_winShellResolved = { kind: "bash", path: gitBash });
  const pwsh = findOnPath("pwsh.exe");
  if (pwsh) return (_winShellResolved = { kind: "pwsh", path: pwsh });
  return (_winShellResolved = {
    kind: "powershell",
    path: findOnPath("powershell.exe") ?? "powershell.exe",
  });
}

// Back-compat string accessor. Prefer resolveWindowsShell() when you also need
// the kind (to pick `-c` vs `-NoProfile -Command` and to skip the POSIX→PS
// translation when the shell is a real bash).
export function getWindowsShell(): string {
  return resolveWindowsShell().path;
}

// Test-only: drop the memoized resolution so a test can re-resolve under a
// different PATH / install layout.
export function _resetWindowsShellCache(): void {
  _winShellResolved = null;
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

// Does a finished subprocess look like an AV behavior-shield KILL rather than a
// normal command failure? AV (AVG/Avast/Norton/Defender heuristic) hunts
// `powershell.exe` specifically — the constantly-varying `-Command` string is
// the living-off-the-land attacker signature — so this only fires on the
// PowerShell path. A signed Git-for-Windows `bash.exe` is NOT that target, and
// under it a fast, no-output, non-zero exit is an ordinary command error
// (exit 127 = command-not-found), not an AV kill — flagging it produced the
// misleading "antivirus signature" message we saw once Git Bash became the
// default shell. Exit 127 is excluded on every path for the same reason. Pure +
// exported so the heuristic is unit-testable without spawning a process.
export function isLikelyAvKill(p: {
  isPowerShell: boolean;
  code: number | null;
  elapsedMs: number;
  stdoutLen: number;
  cmdLen: number;
}): boolean {
  return (
    p.isPowerShell &&
    (p.code === null || (p.code !== 0 && p.code !== 1 && p.code !== 127)) &&
    p.elapsedMs < 800 &&
    p.stdoutLen === 0 &&
    p.cmdLen > 8
  );
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
  // Generic credential-name stems the per-vendor list above misses: any var
  // ending in _KEY / _PASS / _PWD / _DSN carries a key, password, or
  // connection string regardless of vendor (SUPABASE_KEY, SMTP_PASS,
  // MYSQL_PWD, SENTRY_DSN). Anchored on a `_` boundary so it doesn't catch
  // innocuous names like BYPASS or MONKEY.
  /_key$/i, /_pass$/i, /_pwd$/i, /_dsn$/i, /passphrase/i, /connection[_-]?string/i,
  /^AWS_/i, /^AZURE_/i, /^GCP_/i, /^GOOGLE_/i,
  /^OPENAI/i, /^XAI/i, /^LAX_AUTH/i, /^LAX_.*KEY/i,
  /^GITHUB_/i, /^SLACK_/i, /^STRIPE_/i, /^LINEAR_/i,
  /^NPM_TOKEN/i, /^DOCKER_/i, /^CI_/i,
];

// Value-shape detector for credentials embedded in a connection string —
// `scheme://user:pass@host`. This is naming-convention-independent: it catches
// the password in DATABASE_URL / MONGODB_URI / REDIS_URL / AMQP_URL no matter
// what the var is called, closing the class the name-denylist can't (their
// URL punctuation `://@:` also slips the high-entropy value gate below).
const CONNECTION_STRING_CREDENTIAL = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i;

// LAX's bundled node_modules — so an agent-spawned `node build.js` (run with
// the workspace as cwd, where there is no node_modules) can still resolve
// bundled deps like pptxgenjs via a BARE `require('pptxgenjs')`. Anchored on
// pptxgenjs, a hard dependency, so the path is correct however LAX itself was
// installed (global npm, local, packaged). Resolved once.
let _bundledNodeModules: string | null | undefined;
function bundledNodeModulesDir(): string | null {
  if (_bundledNodeModules !== undefined) return _bundledNodeModules;
  try {
    // Resolve the package entry (not "pptxgenjs/package.json" — its exports map
    // blocks that deep subpath), then take the enclosing node_modules. The
    // entry may be nested (.../node_modules/pptxgenjs/dist/pptxgen.cjs.js), so
    // slice at the node_modules segment rather than counting dirname hops.
    const entry = createRequire(import.meta.url).resolve("pptxgenjs");
    const marker = `${sep}node_modules${sep}`;
    const idx = entry.lastIndexOf(marker);
    _bundledNodeModules = idx >= 0 ? entry.slice(0, idx + marker.length - 1) : null;
  } catch {
    _bundledNodeModules = null;
  }
  return _bundledNodeModules;
}

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
    if (CONNECTION_STRING_CREDENTIAL.test(value)) continue;
    sanitizedEnv[key] = value;
  }
  const bundled = bundledNodeModulesDir();
  if (bundled) {
    sanitizedEnv.NODE_PATH = sanitizedEnv.NODE_PATH
      ? `${sanitizedEnv.NODE_PATH}${delimiter}${bundled}`
      : bundled;
  }
  // Git must never block on an interactive credential prompt in an automated
  // agent shell. Without a controlling TTY a private-repo `git clone` hangs on
  // /dev/tty (Windows: "could not read Password ... /dev/tty: No such device")
  // instead of failing — exactly what stalled the 2026-06-27 ingest session.
  // Force non-interactive: stored creds / Git Credential Manager still work
  // (credential.helper is invoked, not askpass), but a MISSING credential now
  // fails fast with a clear error the agent can report. Set before the `extra`
  // overlay so an explicit caller override still wins.
  sanitizedEnv.GIT_TERMINAL_PROMPT = "0";
  if (sanitizedEnv.GIT_ASKPASS === undefined) sanitizedEnv.GIT_ASKPASS = "";
  // Pagers hang a non-interactive shell. `git log`/`git diff`/`git branch`
  // (and `man`, `less`, `psql`) pipe their output to a pager that waits for `q`
  // with no controlling TTY, so the command never returns and the turn stalls
  // until the timeout fires. Force straight-through output: GIT_PAGER wins over
  // core.pager/PAGER for git, PAGER covers the non-git tools. Set unconditionally
  // (an inherited PAGER=less would reintroduce the hang) but before the `extra`
  // overlay, so an explicit caller can still opt back into a pager.
  sanitizedEnv.GIT_PAGER = "cat";
  sanitizedEnv.PAGER = "cat";
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string" && !v.includes("\0")) sanitizedEnv[k] = v;
    }
  }
  return sanitizedEnv;
}
