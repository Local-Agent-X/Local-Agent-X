// The argv-level shell rules, one per refused command shape. Each reads a
// command position from commandPositions (shell-command-positions.ts): its real
// command word, its own arguments, the wrappers in front of it, and whether its
// stdin is a pipe. These replace raw-string patterns that matched the same words
// anywhere in the line — inside commit messages, grep patterns, echo text.

import { type CommandPosition } from "./shell-command-positions.js";
import { execBasename, isShellReparseFlag } from "./shell-lex.js";
import { INLINE_CODE_PATTERNS, INTERP_EVAL_FLAGS, NETWORK_CLIENT_BINS } from "./shell-rules.js";

// The inline program an interpreter was handed (`python -c "<code>"`, `node -e
// "<code>"`, an awk program): the word after an eval flag, or for awk, its words.
function inlineCode(p: CommandPosition): string[] {
  const args = argsOf(p);
  if (AWK_BINS.has(p.bin)) return args;
  const flags = INTERP_EVAL_FLAGS[p.bin];
  if (!flags) return [];
  return args.filter((_, i) => i > 0 && flags.has(args[i - 1]));
}

export type CommandRuleCategory =
  | "shell-escape" | "privilege" | "disk" | "system-config"
  | "persistence" | "credential" | "obfuscation" | "local-server" | "opener" | "network";

export interface CommandRule {
  id: string;
  category: CommandRuleCategory;
  /** Finishes "Blocked: `<bin>` …" — what the command does that is refused. */
  why: string;
  matches(p: CommandPosition): boolean;
  /** The word to name in the refusal, when it is not the command word (a wrapper). */
  offender?(p: CommandPosition): string;
}

const argsOf = (p: CommandPosition) => p.words.slice(p.at + 1);
const lower = (s: string | undefined) => (s ?? "").toLowerCase();

function bins(id: string, category: CommandRuleCategory, why: string, names: string[]): CommandRule {
  const set = new Set(names);
  return { id, category, why, matches: (p) => set.has(p.bin) };
}

function binWith(
  id: string, category: CommandRuleCategory, why: string, names: string[], when: (args: string[]) => boolean,
): CommandRule {
  const set = new Set(names);
  return { id, category, why, matches: (p) => set.has(p.bin) && when(argsOf(p)) };
}

// `eval` and PowerShell's equivalents run a STRING as a command: whatever it
// builds is invisible to every rule that reads the command line.
const EVAL_BINS = new Set(["eval", "iex", "invoke-expression"]);
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
const AWK_BINS = new Set(["awk", "gawk", "mawk", "nawk"]);
const PRIVILEGE_BINS = new Set(["sudo", "doas"]);
const REG_VERBS = new Set(["add", "delete", "query", "export", "import", "save", "restore", "load", "unload"]);

// Does this shell take its SCRIPT from stdin? Only then is a pipe into it "run
// whatever the previous command printed". `find . | xargs bash -c '…'` runs a
// visible, walked body; `curl … | sh` runs the download.
function readsScriptFromStdin(p: CommandPosition): boolean {
  const args = argsOf(p);
  if (POSIX_SHELLS.has(p.bin)) {
    if (args.some((a) => isShellReparseFlag(p.bin, a))) return false;
    if (args.some((a) => /^-[a-zA-Z]*s[a-zA-Z]*$/.test(a))) return true; // `sh -s`: script from stdin
    return !args.some((a) => a !== "-" && !/^[-+]/.test(a)); // no script-file operand
  }
  if (p.bin === "cmd") return !args.some((a) => /^\/[ck]$/i.test(a));
  if (p.bin === "powershell" || p.bin === "pwsh") {
    const l = args.map(lower);
    if (l.includes("-file") || l.includes("-f")) return false;
    const c = l.findIndex((a) => a === "-command" || a === "-c");
    if (c >= 0) return c + 1 >= l.length || l[c + 1] === "-";
    return !l.some((a) => !a.startsWith("-"));
  }
  return false;
}

// PowerShell takes any unambiguous prefix of -EncodedCommand, plus -e and -ec.
function isEncodedCommandFlag(a: string): boolean {
  const l = lower(a);
  return l === "-e" || l === "-ec" || (l.length >= 4 && "-encodedcommand".startsWith(l));
}

export const COMMAND_RULES: readonly CommandRule[] = [
  // ── Commands hidden from the checks ──
  { id: "eval", category: "shell-escape", why: "runs a string as a command, which hides that command from every check",
    matches: (p) => EVAL_BINS.has(p.bin) },
  { id: "pipe-into-shell", category: "shell-escape", why: "runs whatever the previous command printed as a script",
    matches: (p) => p.piped && readsScriptFromStdin(p) },
  { id: "awk-pipe-into-shell", category: "shell-escape", why: "pipes its output into a shell from inside the awk program",
    matches: (p) => AWK_BINS.has(p.bin) && argsOf(p).some((a) => /\|\s*"\s*(?:\S*\/)?(?:ba|z|da|k|a)?sh\b/.test(a)) },
  { id: "inline-code", category: "shell-escape", why: "runs inline code that calls a refused command",
    matches: (p) => inlineCode(p).some((code) => INLINE_CODE_PATTERNS.some((re) => re.test(code))) },
  binWith("inline-interpreter", "shell-escape", "runs an inline program the shell checks cannot read",
    ["perl", "ruby", "php"], (a) => (a[0] === "-e" || a[0] === "-E") || lower(a[0]) === "-r"),
  binWith("source-absolute", "shell-escape", "runs a script from an absolute path inside this shell",
    [".", "source"], (a) => (a[0] ?? "").startsWith("/")),
  binWith("interactive-shell", "shell-escape", "starts an interactive session, the building block of a reverse shell",
    ["bash", "sh", "zsh", "python"], (a) => a.includes("-i")),
  binWith("node-inspector", "shell-escape", "opens a debugger port that runs arbitrary code",
    ["node"], (a) => a.some((x) => x.startsWith("--inspect"))),
  bins("named-pipe", "shell-escape", "creates a named pipe, the building block of a reverse shell", ["mkfifo"]),
  binWith("detached-session", "persistence", "starts a detached session that outlives the command",
    ["screen"], (a) => a.some((x) => /^-[dD]/.test(x))),
  binWith("detached-session", "persistence", "starts a detached session that outlives the command",
    ["tmux"], (a) => (a[0] ?? "").startsWith("new")),
  binWith("terminal-exec", "shell-escape", "runs a program in a new terminal window",
    ["xterm"], (a) => a.includes("-e")),

  // ── Privilege ──
  { id: "privilege", category: "privilege", why: "runs a command as another user (administrator)",
    matches: (p) => p.words.slice(0, p.at + 1).some((w) => PRIVILEGE_BINS.has(execBasename(w))),
    offender: (p) => p.words.slice(0, p.at + 1).find((w) => PRIVILEGE_BINS.has(execBasename(w))) ?? p.words[p.at] },

  // ── Disks ──
  { id: "make-filesystem", category: "disk", why: "formats a disk or partition",
    matches: (p) => p.bin.startsWith("mkfs") },
  binWith("raw-disk-write", "disk", "writes raw blocks to a device or file", ["dd"],
    (a) => a.some((x) => lower(x).startsWith("of="))),
  binWith("format-drive", "disk", "formats a drive", ["format"], (a) => /^(?:\/|\\|[a-z]:)/i.test(a[0] ?? "")),
  bins("partition", "disk", "edits a disk's partition table", ["fdisk", "parted", "diskpart"]),

  // ── System configuration ──
  binWith("world-writable", "system-config", "makes files writable by every user", ["chmod"], (a) => a.includes("777")),
  binWith("user-accounts", "system-config", "changes Windows user accounts", ["net"], (a) => lower(a[0]) === "user"),
  binWith("registry", "system-config", "reads or changes the Windows registry", ["reg"], (a) => REG_VERBS.has(lower(a[0]))),
  bins("wmi", "system-config", "runs Windows management commands", ["wmic"]),
  bins("scheduled-task", "persistence", "creates or runs a scheduled task", ["schtasks"]),

  // ── macOS automation and persistence ──
  bins("launchd", "persistence", "installs or runs a background job", ["launchctl"]),
  bins("macos-automation", "persistence", "runs a workflow or script outside this shell", ["automator", "shortcuts", "osacompile"]),
  binWith("launch-agent", "persistence", "installs a login item", ["defaults"],
    (a) => lower(a[0]) === "write" && /Launch(Agents|Daemons)/i.test(a.join(" "))),
  bins("app-opener", "opener", "hands work to another application outside this shell", ["osascript", "xdg-open"]),

  // ── Credentials ──
  bins("credential-dumper", "credential", "dumps stored credentials", ["mimikatz", "hashdump"]),
  binWith("keychain", "credential", "reads a password from the macOS keychain", ["security"],
    (a) => lower(a[0]) === "find-generic-password" || lower(a[0]) === "find-internet-password"),

  // ── Obfuscation ──
  binWith("base64-decode", "obfuscation", "decodes hidden content, a common way to smuggle a command", ["base64"],
    (a) => a.some((x) => x === "--decode" || /^-[a-zA-Z]*[dD]/.test(x))),
  binWith("encoded-powershell", "obfuscation", "runs a base64-encoded PowerShell command the checks cannot read",
    ["powershell", "pwsh"], (a) => a.some(isEncodedCommandFlag)),
  // The command word only: `git rev-parse`, `git rev-list` and a `rev` inside
  // a commit message or grep pattern are not it.
  bins("reverse-text", "obfuscation", "reverses its input, a common way to hide a command", ["rev"]),

  // ── Network egress (skipped where a kernel cage holds egress: findCommandRuleHit) ──
  { id: "network-client", category: "network", why: "reaches the network directly, outside the checked HTTP path",
    matches: (p) => NETWORK_CLIENT_BINS.has(p.bin) },
  binWith("raw-tls", "network", "opens a raw TLS connection to any host", ["openssl"],
    (a) => lower(a[0]) === "s_client" || lower(a[0]) === "s_server"),

  // ── Servers reachable from outside ──
  binWith("local-server", "local-server", "starts a server other machines could reach", ["python"],
    (a) => a.some((x, i) => x === "-m" && (a[i + 1] === "http.server" || a[i + 1] === "smtpd"))),
  binWith("local-server", "local-server", "starts a server other machines could reach", ["php"], (a) => a.includes("-S")),
  binWith("local-server", "local-server", "starts a server other machines could reach", ["npx"], (a) => a[0] === "serve"),
];
