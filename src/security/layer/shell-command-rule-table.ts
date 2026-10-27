// The argv-level shell rules, one per refused command shape. Each reads a
// command position from commandPositions (shell-command-positions.ts): its real
// command word, its own arguments, the wrappers in front of it, and whether its
// stdin is a pipe. These replace raw-string patterns that matched the same words
// anywhere in the line — inside commit messages, grep patterns, echo text.

import { type CommandPosition } from "./shell-command-positions.js";
import { execBasename, isShellReparseFlag } from "./shell-lex.js";
import { INLINE_CODE_PATTERNS, INTERP_EVAL_FLAGS, NETWORK_CLIENT_BINS } from "./shell-rules.js";
import { ENVIRONMENT_SETUP_OUTPUT } from "./shell-nested-commands.js";

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
  | "persistence" | "background" | "inline-program" | "credential" | "obfuscation" | "local-server" | "opener" | "network";

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

// A path that names a disk or other device rather than a file: anything under
// /dev but the stream devices, and Windows' raw drive paths. /dev reached by
// climbing (`../../dev/sda` from a working folder) is the same disk.
const DEV_PATH = /^(?:\/|(?:\.\.?\/)+)+dev\/(.+)$/i;
const STREAM_DEVICE = /^(?:null|zero|full|u?random|stdout|stderr|tty|fd\/\d+|shm\/.+)$/i;
function isDiskDevice(path: string): boolean {
  const dev = DEV_PATH.exec(path);
  return (dev !== null && !STREAM_DEVICE.test(dev[1])) || /^\\\\[.?]\\/.test(path);
}
const lower = (s: string | undefined) => (s ?? "").toLowerCase();

// The partition editors. diskpart works only on the machine's own disks.
const PARTITION_BINS = new Set(["fdisk", "sfdisk", "cfdisk", "gdisk", "sgdisk", "parted", "diskpart"]);
// Those whose `-l` lists every disk's table and exits, writing nothing.
const LISTS_ALL_DISKS = new Set(["fdisk", "sfdisk", "parted"]);

// Does this partition editor touch only files, never a disk? Like dd above, a
// disk image (`fdisk disk.img`, `parted -s pi.img mklabel msdos`) is a file
// write. Any word naming a device refuses it, and so does naming no target at
// all: parted and cfdisk then open the first disk, gdisk asks on stdin which.
function partitionsOnlyFiles(bin: string, args: string[]): boolean {
  if (bin === "diskpart") return false;
  if (args.some((a) => isDiskDevice(a) || isDiskDevice(a.slice(a.indexOf("=") + 1)))) return false;
  const operands = args.filter((a, i) => !a.startsWith("-") && !(bin === "parted" && ["-a", "--align"].includes(args[i - 1])));
  if (operands.length > 0) return true;
  return LISTS_ALL_DISKS.has(bin) && args.some((a) => a === "-l" || a === "--list");
}

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
  // Except a version manager's environment printout, `eval "$(opam env)"`: the
  // installed tool's own setup code (ENVIRONMENT_PRINTERS, shell-nested-commands.ts).
  { id: "eval", category: "shell-escape", why: "runs a string as a command, which hides that command from every check",
    matches: (p) => EVAL_BINS.has(p.bin) && !(argsOf(p).length === 1 && argsOf(p)[0] === ENVIRONMENT_SETUP_OUTPUT) },
  { id: "pipe-into-shell", category: "shell-escape", why: "runs whatever the previous command printed as a script",
    matches: (p) => p.piped && readsScriptFromStdin(p) },
  { id: "awk-pipe-into-shell", category: "shell-escape", why: "pipes its output into a shell from inside the awk program",
    matches: (p) => AWK_BINS.has(p.bin) && argsOf(p).some((a) => /\|\s*"\s*(?:\S*\/)?(?:ba|z|da|k|a)?sh\b/.test(a)) },
  { id: "inline-code", category: "shell-escape", why: "runs inline code that calls a refused command",
    matches: (p) => inlineCode(p).some((code) => INLINE_CODE_PATTERNS.some((re) => re.test(code))) },
  // The form itself, like python -c's inline-eval refusal: where the shape
  // rules stand down it runs, while the inline-code rule above and the
  // inline-network scan still read the program for what it calls.
  binWith("inline-interpreter", "inline-program", "runs an inline program the shell checks cannot read",
    ["perl", "ruby", "php"], (a) => (a[0] === "-e" || a[0] === "-E") || lower(a[0]) === "-r"),
  binWith("source-absolute", "shell-escape", "runs a script from an absolute path inside this shell",
    [".", "source"], (a) => (a[0] ?? "").startsWith("/")),
  binWith("interactive-shell", "shell-escape", "starts an interactive session, the building block of a reverse shell",
    ["bash", "sh", "zsh", "python"], (a) => a.includes("-i")),
  binWith("node-inspector", "shell-escape", "opens a debugger port that runs arbitrary code",
    ["node"], (a) => a.some((x) => x.startsWith("--inspect"))),
  bins("named-pipe", "shell-escape", "creates a named pipe, the building block of a reverse shell", ["mkfifo"]),
  binWith("detached-session", "background", "starts a detached session that outlives the command",
    ["screen"], (a) => a.some((x) => /^-[dD]/.test(x))),
  binWith("detached-session", "background", "starts a detached session that outlives the command",
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
  // A device, not a file: `dd if=/dev/zero of=test.img` and carving bytes out
  // of a disk image are file writes, checked by the shell path guard like any.
  binWith("raw-disk-write", "disk", "writes raw blocks to a disk device", ["dd"],
    (a) => a.some((x) => lower(x).startsWith("of=") && isDiskDevice(x.slice(3)))),
  binWith("format-drive", "disk", "formats a drive", ["format"], (a) => /^(?:\/|\\|[a-z]:)/i.test(a[0] ?? "")),
  { id: "partition", category: "disk", why: "edits a disk's partition table",
    matches: (p) => PARTITION_BINS.has(p.bin) && !partitionsOnlyFiles(p.bin, argsOf(p)) },

  // ── System configuration ──
  binWith("world-writable", "system-config", "makes files writable by every user", ["chmod"], (a) => a.includes("777")),
  binWith("user-accounts", "system-config", "changes Windows user accounts", ["net"], (a) => lower(a[0]) === "user"),
  binWith("registry", "system-config", "reads or changes the Windows registry", ["reg"], (a) => REG_VERBS.has(lower(a[0]))),
  bins("wmi", "system-config", "runs Windows management commands", ["wmic"]),
  bins("scheduled-task", "persistence", "creates or runs a scheduled task", ["schtasks", "register-scheduledtask", "set-scheduledtask", "start-scheduledtask"]),
  // The PowerShell spellings of a Run-key entry: `reg add` above is the only
  // one the table knew, so a login-time program could be planted with a cmdlet.
  binWith("run-key", "persistence", "adds a program that runs at login", ["set-itemproperty", "new-itemproperty", "new-item", "sp"],
    (a) => /CurrentVersion[\\/]+Run(Once)?\b/i.test(a.join(" "))),

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
  // A base64 decode by itself is not here: decoding is ordinary, and the
  // dangerous use (decoded text handed to a shell or interpreter in the same
  // command) is refused by detectObfuscation in shell-detectors.ts.
  binWith("encoded-powershell", "obfuscation", "runs a base64-encoded PowerShell command the checks cannot read",
    ["powershell", "pwsh"], (a) => a.some(isEncodedCommandFlag)),
  // Reversing text (`rev`) is not here either: it is ordinary sequence work (a
  // DNA reverse complement); reversed text handed to a shell is refused with
  // decoding, by detectObfuscation.

  // ── Network egress (skipped where a kernel cage holds egress: findCommandRuleHit) ──
  { id: "network-client", category: "network", why: "reaches the network directly, outside the checked HTTP path",
    matches: (p) => NETWORK_CLIENT_BINS.has(p.bin) },
  binWith("raw-tls", "network", "opens a raw TLS connection to any host", ["openssl"],
    (a) => lower(a[0]) === "s_client" || lower(a[0]) === "s_server"),

  // ── Ad-hoc web servers (python -m http.server and kin) ──
  // Refused even with --bind 127.0.0.1: a page the agent wrote is already served
  // by LAX (/files/), and a project has its own dev script. The reason says the
  // default, so it stays true when a command binds loopback (chat-mvk9jq7d told
  // the user a loopback-bound server "could be reached from other machines").
  binWith("local-server", "local-server", "starts a web server of its own, which by default every machine on the network can reach", ["python"],
    (a) => a.some((x, i) => x === "-m" && (a[i + 1] === "http.server" || a[i + 1] === "smtpd"))),
  binWith("local-server", "local-server", "starts a web server of its own, which by default every machine on the network can reach", ["php"], (a) => a.includes("-S")),
  binWith("local-server", "local-server", "starts a web server of its own, which by default every machine on the network can reach", ["npx"], (a) => a[0] === "serve"),
];
