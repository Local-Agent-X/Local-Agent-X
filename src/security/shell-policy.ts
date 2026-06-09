import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";
import { countTopLevelPipes } from "../tools/shell-translate.js";

// Commands that should never be executed, even without metacharacters
const BLOCKED_COMMANDS = [
  /\brm\s+.*(-[a-zA-Z]*f|-[a-zA-Z]*r)\b/i,  // rm with -f or -r flags (catches split flags like `rm -a -f`)
  /\bsudo\b/i,
  /\bchmod\s+777\b/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of=/i,
  /\bformat\b.*[/\\]/i,
  // Language-wrapper escapes (allow python -c and node -e for data transforms)
  /\beval\b/i,
  // Bare interpreter-escape forms. These catch `perl -e`, `ruby -e`, `php -r`
  // with the flag IMMEDIATELY after the binary. Intervening flags (`perl -w
  // -e`, `ruby -rsocket -e`) slip past these word-boundary patterns, so the
  // argv-aware detectInterpreterEscape() below is the real wall (C3-13). These
  // remain as cheap, regex-level backstops.
  /\bperl\s+-e\b/i,
  /\bruby\s+-e\b/i,
  /\bphp\s+-r\b/i,
  // Encoding / obfuscation
  /\bbase64\s+(-[a-zA-Z]*d|--decode)\b/i,  // catches -d, -di, -id, --decode
  /\bpowershell\b.*-enc/i,
  // Windows-specific
  /\bnet\s+user\b/i,
  /\breg\s+(add|delete|query|export|import|save|restore|load|unload)\b/i,
  /\bwmic\b/i,
  /\bschtasks\b/i,
  // Network exfil via pipe
  /\bcurl\b.*\|/i,
  /\bwget\b.*\|/i,
  /\|.*\b(bash|sh|cmd|powershell)\b/i,
  // ── Shell-as-exfiltration: best-effort denylist of network clients ──
  // These can send data to arbitrary hosts, bypassing all HTTP/SSRF controls.
  // The agent should use http_request (which has SSRF checks, DNS pinning,
  // content wrapping, and audit logging) instead of raw shell network tools.
  // This is a BEST-EFFORT denylist, not an exhaustive wall — the structural
  // answer is the argv[0] allowlist; this chunk hardens the denylist with the
  // common clients. New/renamed binaries can still slip a denylist.
  /\bcurl\s/i,                              // curl (any use)
  /\bwget\s/i,                              // wget (any use)
  /\bnc\s/i,                                // netcat
  /\bncat\s/i,                              // nmap netcat
  /\bsocat\s/i,                             // socat
  /\btelnet\s/i,                            // telnet
  /\bssh\s/i,                               // ssh (outbound)
  /\bscp\s/i,                               // scp
  /\bsftp\s/i,                              // sftp
  /\brsync\s/i,                             // rsync
  /\bftp\s/i,                               // ftp
  /\baria2c\s/i,                            // aria2c download utility
  /\btftp\s/i,                              // trivial FTP client
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
  /\bdig\s/i,                               // DNS lookup (data-in-subdomain exfil)
  /\bhost\s/i,                              // DNS lookup
  /\bnslookup\s/i,                          // DNS lookup
  /\bgetent\s/i,                            // NSS lookup (hosts → DNS)
  /\bping\s/i,                              // ICMP (data-in-hostname exfil)
  /\btraceroute\s/i,                        // route probe (egress)
  /\bosascript\s/i,                         // macOS AppleScript (wraps `do shell script`)
  /\bopen\s/i,                              // macOS opener (launches browser/app w/ URL)
  /\bxdg-open\s/i,                          // Linux opener (launches browser/app w/ URL)
  // ── macOS persistence / automation primitives (C3-12/C3-14) ──
  // These install background jobs or run script-as-shell, an RCE/persistence
  // path that needs no metacharacters. `launchctl submit -l x -- /bin/sh -c
  // '…'` is metachar-free argv-RCE, so block on the `launchctl` binary name.
  /\blaunchctl\b/i,                         // launchd control (submit/load → persistence + argv-RCE)
  /\bautomator\b/i,                         // macOS Automator (runs workflows)
  /\bshortcuts\s/i,                         // macOS Shortcuts CLI (runs shortcuts)
  /\bosacompile\b/i,                        // compiles AppleScript (wraps shell)
  /\bdefaults\s+write\b.*Launch(Agents|Daemons)/i, // persistence via LaunchAgents/Daemons plist
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
  /^\.\s+\//,                               // dot-sourcing: ". /path" (source command)
  /\bsource\s+\//i,                         // source /path
  /[<>]&\d/,                                // fd redirection: <&3, >&3
  /\d+>&\d/,                                // fd duplication: 2>&1 in exotic forms
  /\\\n/,                                   // backslash-newline continuation (multi-line escape)
  // ── Interactive shell / reverse shell escapes ──
  /\bbash\s+-i\b/i,                         // interactive bash
  /\bsh\s+-i\b/i,                           // interactive sh
  /\bzsh\s+-i\b/i,                          // interactive zsh
  /\bpython[23]?\s+-i\b/i,                  // interactive Python
  /\bnode\s+--inspect/i,                     // Node debugger (can execute arbitrary code)
  /\b\/dev\/tcp\//i,                         // bash /dev/tcp reverse shell
  /\bmkfifo\b/i,                             // named pipe (reverse shell building block)
  /\bexec\s+\d+<>/i,                        // fd exec redirect (reverse shell)
  /\bnohup\b.*&$/i,                          // background persistent process
  /\bscreen\s+-[dD]/i,                       // detached screen session
  /\btmux\s+new/i,                           // tmux session (persistence)
  /\bxterm\b.*-e/i,                          // xterm reverse shell
  // ── Additional network exfiltration vectors ──
  /\bpython[23]?\s+-m\s+http\.server\b/i,    // Python HTTP server
  /\bpython[23]?\s+-m\s+smtpd\b/i,           // Python SMTP server
  /\bphp\s+-S\b/i,                           // PHP built-in server
  /\bnpx\s+serve\b/i,                        // npx serve
  /\bdnscat\b/i,                             // DNS tunnel
  /\bchisel\b/i,                             // TCP tunnel
  // ── Credential access ──
  /\bmimikatz\b/i,                           // Windows credential dumper
  /\bhashdump\b/i,                           // Hash dumper
  /\bcredential\s+manager/i,                 // Windows credential manager
  /\bsecurity\s+find-generic-password/i,     // macOS keychain access
  // ── Disk/partition manipulation ──
  /\bfdisk\b/i,                              // Partition table editor
  /\bparted\b/i,                             // Partition editor
  /\bmount\s+/i,                             // Mount filesystems
  /\bumount\s+/i,                            // Unmount filesystems
];

export function detectObfuscation(command: string): string | null {
  // Hex-encoded sequences (e.g., \x72\x6d = "rm")
  if (/\\x[0-9a-f]{2}/i.test(command)) {
    return "Blocked: hex-encoded characters detected (possible obfuscation)";
  }
  // Octal escapes (e.g. \162\155 = "rm") are handled by the two ANSI-C / printf
  // checks below — there is deliberately NO bare-\NNN test here. bash does not
  // interpret a bare \NNN (`echo \162` prints "162", not "r"); the only real
  // octal attack vectors are the interpreted forms $'\162' and printf '\162',
  // caught by the "ANSI-C quoting with octal escapes" and "printf with escape
  // sequences" rules below. A bare-\NNN test added nothing over those and
  // false-positived on ordinary Windows paths, where the backslash is a path
  // separator: C:\Users\...\2024 May order.xlsx contains "\202" and was blocked
  // in every file-access mode.
  // Unicode escape sequences (e.g., rm = "rm")
  if (/\\u[0-9a-f]{4}/i.test(command)) {
    return "Blocked: unicode escape sequences detected (possible obfuscation)";
  }
  // Base64 inline decoding (echo BASE64 | base64 -d)
  if (/base64\s+(-d|--decode)/i.test(command)) {
    return "Blocked: base64 decode in command (possible obfuscation)";
  }
  // printf with escape sequences (printf '\x72\x6d')
  if (/\bprintf\b.*\\(x|u|[0-7])/i.test(command)) {
    return "Blocked: printf with escape sequences (possible obfuscation)";
  }
  // xxd / od reverse (decode hex to binary)
  if (/\bxxd\s+-r\b/i.test(command) || /\bod\b.*-A\s*x/i.test(command)) {
    return "Blocked: hex decode tool (possible obfuscation)";
  }
  // String concatenation tricks: a='r'; b='m'; $a$b
  // We already block $ metacharacter, but check for quoted var assignment patterns
  if (/\b[a-z]=['"][a-z]{1,3}['"]/i.test(command) && command.split("=").length > 3) {
    return "Blocked: suspicious variable assignment pattern (possible string concatenation obfuscation)";
  }
  // rev (reverse string to hide commands)
  if (/\brev\b/i.test(command)) {
    return "Blocked: 'rev' command (commonly used for obfuscation)";
  }
  // ANSI-C quoting with hex escapes (e.g., $'\x72\x6d')
  if (/\$'[^']*\\x[0-9a-fA-F]{2}/.test(command)) {
    return "Blocked: ANSI-C quoting with hex escapes detected";
  }
  // ANSI-C quoting with octal escapes (e.g., $'\162\155')
  if (/\$'[^']*\\[0-7]{3}/.test(command)) {
    return "Blocked: ANSI-C quoting with octal escapes detected";
  }
  // Very long commands are suspicious (likely encoded payloads)
  if (command.length > 2000) {
    return "Blocked: command exceeds 2000 characters (possible encoded payload)";
  }

  return null;
}

// Hard-block heredoc + inline-script writes targeting the repo. Workers were
// using `cat <<EOF > foo` and `python -c "open(...).write(...)"` to "edit"
// files; bash exits 0 even when the script silently no-ops, so the worker
// reported success after writing nothing. Force them to use write/edit tools
// (which return verifiable confirmations).
function detectScriptWrite(command: string): string | null {
  // 1. Heredoc redirected to a file: `<<EOF >`, `<<-EOF >>`, `<<'EOF' > path`, etc.
  if (/<<-?\s*['"]?\w+['"]?[\s\S]*?>{1,2}\s*\S/.test(command)) {
    return "Use the write/edit tools instead — bash exit 0 ≠ work done.";
  }
  // 2. python/node/perl/ruby -c "..." that calls open()/write_text/writeFile/etc.
  //    We only flag when both an inline-script flag AND a write call appear.
  const hasInlineScript = /\b(python[23]?|node|perl|ruby)\b\s+-[ce]\s/i.test(command);
  if (hasInlineScript) {
    const writeCallPatterns = [
      /\bopen\s*\([^)]*,\s*['"][wax]b?\+?/i,              // open(path, 'w'/'a'/'x' or 'wb'/'ab'/'w+') - mode must be 2nd positional arg
      /\.write_text\s*\(/i,                              // pathlib write_text
      /\.write_bytes\s*\(/i,                             // pathlib write_bytes
      /\bwriteFileSync\s*\(/i,                           // node fs.writeFileSync
      /\bfs\.writeFile\s*\(/i,                           // node fs.writeFile
      /\bappendFileSync\s*\(/i,                          // node fs.appendFileSync
      /\bPath\s*\([^)]*\)\.write/i,                      // pathlib Path(p).write_*
      /\bshutil\.(copy|move)/i,                          // python shutil mutating
    ];
    if (writeCallPatterns.some(p => p.test(command))) {
      return "Use the write/edit tools instead — bash exit 0 ≠ work done.";
    }
  }
  // 3. sed -i / awk inplace editing files in-place
  if (/\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*|-(-in-place))\b/i.test(command)) {
    return "Use the write/edit tools instead — bash exit 0 ≠ work done.";
  }
  if (/\bawk\b[^|]*\binplace\b/i.test(command)) {
    return "Use the write/edit tools instead — bash exit 0 ≠ work done.";
  }
  // 4. Plain redirect of `echo`/`printf` to a writable file path is allowed
  //    (small one-liners don't trip the silent-noop bug). Heredocs are the
  //    real problem because they swallow newlines + multi-line content.
  return null;
}

// Remove the contents of single- and double-quoted spans (and the quotes)
// so shell separators that are literal inside an argument — e.g. the `;` in
// `python -c "a; b"` — aren't mistaken for command chaining.
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
const BROWSER_OPEN_CMDS =
  /\b(start\s+(https?:|www\.|"?https?:)|explorer\s+(https?:|"?https?:)|open\s+(https?:|"?https?:)|xdg-open\s+(https?:|"?https?:)|sensible-browser|wslview\s|powershell.*Start-Process.*https?:|rundll32\s+url\.dll)/i;

function stripQuotedSpans(command: string): string {
  let out = "";
  let quote: string | null = null;
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else {
      out += c;
    }
  }
  return out;
}

// Split a command segment into whitespace-delimited tokens, treating a
// single- or double-quoted span as one opaque token (so the inline script body
// in `perl -e 'use Socket; ...'` is a single token, not the chain-breaking
// words inside it). Quote characters are stripped from the emitted token. Good
// enough for argv[0]/flag inspection — full shell word-splitting is not needed.
function tokenizeCommand(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let inToken = false;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      inToken = true;
    } else if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) { tokens.push(cur); cur = ""; inToken = false; }
    } else {
      cur += c;
      inToken = true;
    }
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

// The basename of an executable token, lowercased, with any path prefix and a
// trailing Windows .exe removed. `/usr/bin/perl` → "perl", `Ruby.EXE` → "ruby".
function execBasename(token: string): string {
  const base = token.replace(/^.*[\\/]/, "").toLowerCase();
  return base.replace(/\.exe$/, "");
}

// ── C3-13: argv-aware interpreter-escape detection ──
// The bare-form denylist (`\bperl\s+-e\b`, …) only catches the flag IMMEDIATELY
// after the binary, so `perl -w -e`, `perl -Mstrict -e`, `ruby -rsocket -e`,
// `ruby -w -e` slip through. Tokenize each pipe segment; if argv[0]'s basename
// is an inline-eval interpreter and ANY later token is an eval/require flag —
// `-e`/`-E`/`-r`, or a clustered short-flag containing e/E/r (e.g. `-we`,
// `-rsocket`) — block it, regardless of intervening flags.
const INTERP_ESCAPE_BINS = new Set(["perl", "ruby", "php"]);

function detectInterpreterEscape(command: string): string | null {
  for (const segment of command.split("|")) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length === 0) continue;
    const bin = execBasename(tokens[0]);
    if (!INTERP_ESCAPE_BINS.has(bin)) continue;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--") break; // end-of-flags; remaining tokens are operands
      if (!t.startsWith("-") || t.startsWith("--")) continue; // operand or long-flag
      // Short-flag (cluster). Flag chars come before any glued value: in
      // `-rsocket` the flag is `r`, "socket" is its argument. The eval/require
      // flags are the LEADING cluster chars up to the first that takes a value.
      // Simplest sound rule: if any of e/E/r appears in the short-flag token's
      // letters, treat it as an inline-eval/require escape.
      const flagBody = t.slice(1);
      if (/[eEr]/.test(flagBody)) {
        return `Blocked: ${bin} inline-eval/require flag (interpreter escape).`;
      }
    }
  }
  return null;
}

// ── C3-12/C3-14: network-client argv[0] denylist ──
// `fetch`/`http`/`https`/`xh`/`httpie`/`curlie` are network clients ONLY when
// they LEAD the command — `git fetch`/`npm fetch` are not. So gate them by the
// argv[0] basename of each pipe segment, never as a substring (spec (e)).
const NETWORK_CLIENT_BINS = new Set([
  "fetch", "http", "https", "xh", "httpie", "curlie",
]);

function detectNetworkClientArgv0(command: string): string | null {
  for (const segment of command.split("|")) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length === 0) continue;
    if (NETWORK_CLIENT_BINS.has(execBasename(tokens[0]))) {
      return "Blocked: raw shell network client — use http_request (SSRF-checked) instead.";
    }
  }
  return null;
}

// ── C3-17: raw-socket / network module use in node -e / python -c bodies ──
// The denylist above flags some HTTP *libraries* (requests/urllib/httpx) but
// misses RAW SOCKETS and the low-level node/python network modules, which give
// the same arbitrary-egress capability inside an inline script body. Broaden
// the inline-interpreter scan to also flag net/socket/https/http(module)/dgram/
// fetch/tls/connect. Only fires when an inline-script flag (node -e / python -c
// / perl -e / ruby -e) AND a network-module reference both appear, matching the
// existing detectScriptWrite style.
function detectInlineNetwork(command: string): string | null {
  const hasInlineScript =
    /\b(python[23]?|node|perl|ruby)\b\s+-[a-zA-Z]*[ce]\b/i.test(command);
  if (!hasInlineScript) return null;
  const networkPatterns = [
    /\bimport\s+socket\b/i,                 // python: import socket
    /\bsocket\.socket\s*\(/i,               // python: socket.socket(...)
    /\brequire\s*\(\s*['"](net|https?|dgram|tls)['"]\s*\)/i, // node: require("net"/"http"/"https"/"dgram"/"tls")
    /\bimport\s+.*\bfrom\s+['"](net|https?|dgram|tls)['"]/i, // node ESM: import x from "net"
    /\bIO::Socket\b/i,                      // perl: IO::Socket
    /\buse\s+Socket\b/i,                    // perl: use Socket
    /\bTCPSocket\b/i,                       // ruby: TCPSocket
    /\bfetch\s*\(/i,                        // node 18+/deno global fetch()
    /\.connect\s*\(/i,                      // socket/Socket .connect(...)
  ];
  if (networkPatterns.some((p) => p.test(command))) {
    return "Blocked: raw socket / network module in inline script — use http_request (SSRF-checked) instead.";
  }
  return null;
}

export function evaluateShellCommand(command: string): SecurityDecision {
  // Obfuscation detection
  try {
    const obfuscationResult = detectObfuscation(command);
    if (obfuscationResult) {
      return { allowed: false, reason: obfuscationResult, userHint: USER_HINTS.commandShell };
    }
  } catch {
    // Don't crash on obfuscation check failure — allow the command through
  }

  // Reject launching a URL in the system browser — route to the browser tool
  // (CDP attach + audit) instead. Checked here so the specific message wins
  // over the generic denylist hit on `open`/`xdg-open`, and so every
  // bash-spawning path (bash, process_start) enforces it.
  if (BROWSER_OPEN_CMDS.test(command)) {
    return {
      allowed: false,
      reason: "Cannot open URLs in the system browser — use the browser tool instead.",
      userHint: USER_HINTS.commandShell,
    };
  }

  // Block heredoc + inline-script writes (forces use of write/edit tools)
  const scriptWriteResult = detectScriptWrite(command);
  if (scriptWriteResult) {
    return { allowed: false, reason: scriptWriteResult, userHint: USER_HINTS.commandShell };
  }

  // C3-13: argv-aware interpreter-escape (perl/ruby/php inline eval with
  // intervening flags — `perl -w -e`, `ruby -rsocket -e`).
  const interpEscape = detectInterpreterEscape(command);
  if (interpEscape) {
    return { allowed: false, reason: interpEscape, userHint: USER_HINTS.commandShell };
  }

  // C3-12/C3-14: network clients gated by argv[0] basename (fetch/http/xh/…),
  // so `git fetch` is unaffected but a leading `http example.com` is blocked.
  const netClient = detectNetworkClientArgv0(command);
  if (netClient) {
    return { allowed: false, reason: netClient, userHint: USER_HINTS.commandShell };
  }

  // C3-17: raw socket / low-level network module use inside node -e / python -c
  // (and perl/ruby) inline bodies — the same arbitrary egress as a network CLI.
  const inlineNet = detectInlineNetwork(command);
  if (inlineNet) {
    return { allowed: false, reason: inlineNet, userHint: USER_HINTS.commandShell };
  }

  // Block dangerous shell metacharacters (command chaining, subshells, command substitution)
  // Allow: | (pipes, controlled below), > < (redirects), * ? (globs)
  // Block dangerous shell metacharacters — platform-aware
  if (process.platform === "win32") {
    // PowerShell: backtick is the escape char, ${} is variable syntax, {} is script blocks — all normal
    // Only block actual dangerous patterns: Invoke-Expression, iex, & (call operator at start)
    if (/\r\n/.test(command)) {
      return { allowed: false, reason: "Blocked: multi-line commands not allowed.", userHint: USER_HINTS.commandShell };
    }
  } else {
    // Bash: block backtick, $(), ${} (command substitution). Kept on the raw
    // command — backtick/$() inside double quotes are still expanded by bash.
    if (/[`\r\n]/.test(command) || /\$\(/.test(command) || /\$\{/.test(command)) {
      return { allowed: false, reason: "Blocked: shell metacharacters detected (backtick or command substitution).", userHint: USER_HINTS.commandShell };
    }
    // Block ; (sequential chaining) and single & (background) but allow && and ||.
    // These are only separators OUTSIDE quotes — a `;` inside
    // `python -c "import json; ..."` is literal to the shell, not a chain.
    const unquoted = stripQuotedSpans(command);
    if (/;/.test(unquoted) || /(?<![&|])&(?![&|])/.test(unquoted)) {
      return { allowed: false, reason: "Blocked: use && instead of ; for chaining, and don't background processes with &.", userHint: USER_HINTS.commandShell };
    }
  }

  // Allow at most 5 pipes (e.g., `ls | grep foo | sort | head | cut`).
  // Quote-aware: literal `|` inside `"..."` / `'...'` doesn't count, and
  // `||` is a chain operator not a pipe. Naive matching false-positived
  // benign commands like `echo "a|b|c|d|e|f"` against this 5-pipe cap.
  const pipeCount = countTopLevelPipes(command);
  if (pipeCount > 5) {
    return {
      allowed: false,
      reason: `Blocked: too many pipes (${pipeCount}). Maximum 5 pipes allowed per command.`,
      userHint: USER_HINTS.commandShell,
    };
  }

  // Check every segment of a piped command against blocked patterns
  const segments = command.split("|").map((s) => s.trim());
  for (const segment of segments) {
    for (const pattern of BLOCKED_COMMANDS) {
      if (pattern.test(segment)) {
        return {
          allowed: false,
          reason: `Blocked: pipe segment matches dangerous pattern.`,
          userHint: USER_HINTS.commandShell,
        };
      }
    }
  }

  // Also check the full command (catches patterns that span pipes)
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Blocked: command matches dangerous pattern.`,
        userHint: USER_HINTS.commandShell,
      };
    }
  }

  return { allowed: true, reason: "Shell command allowed" };
}
