// Static rule tables for the shell-command policy. Pure data: command
// denylist regexes, the browser-open detector, and the argv[0] interpreter /
// network-client basename sets. Consumed by shell-detectors.ts and
// shell-policy.ts; no logic lives here.

// Commands that should never be executed, even without metacharacters
export const BLOCKED_COMMANDS = [
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

// ── C3-12/C3-14: network-client argv[0] denylist ──
// `fetch`/`http`/`https`/`xh`/`httpie`/`curlie` are network clients ONLY when
// they LEAD the command — `git fetch`/`npm fetch` are not. So gate them by the
// argv[0] basename of each pipe segment, never as a substring (spec (e)).
export const NETWORK_CLIENT_BINS = new Set([
  "fetch", "http", "https", "xh", "httpie", "curlie",
]);
