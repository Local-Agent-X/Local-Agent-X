import type { SecurityDecision } from "../types.js";

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
  // ── Shell-as-exfiltration: block network clients entirely ──
  // These can send data to arbitrary hosts, bypassing all HTTP/SSRF controls.
  // The agent should use http_request (which has SSRF checks, DNS pinning,
  // content wrapping, and audit logging) instead of raw shell network tools.
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
  // Octal-encoded sequences (e.g., \162\155 = "rm")
  if (/\\[0-3][0-7]{2}/.test(command)) {
    return "Blocked: octal-encoded characters detected (possible obfuscation)";
  }
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
      /\bopen\s*\([^)]*['"][wax]/i,                      // open(path, 'w'/'a'/'x')
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

export function evaluateShellCommand(command: string): SecurityDecision {
  // Obfuscation detection
  try {
    const obfuscationResult = detectObfuscation(command);
    if (obfuscationResult) {
      return { allowed: false, reason: obfuscationResult };
    }
  } catch {
    // Don't crash on obfuscation check failure — allow the command through
  }

  // Block heredoc + inline-script writes (forces use of write/edit tools)
  const scriptWriteResult = detectScriptWrite(command);
  if (scriptWriteResult) {
    return { allowed: false, reason: scriptWriteResult };
  }

  // Block dangerous shell metacharacters (command chaining, subshells, command substitution)
  // Allow: | (pipes, controlled below), > < (redirects), * ? (globs)
  // Block dangerous shell metacharacters — platform-aware
  if (process.platform === "win32") {
    // PowerShell: backtick is the escape char, ${} is variable syntax, {} is script blocks — all normal
    // Only block actual dangerous patterns: Invoke-Expression, iex, & (call operator at start)
    if (/\r\n/.test(command)) {
      return { allowed: false, reason: "Blocked: multi-line commands not allowed." };
    }
  } else {
    // Bash: block backtick, $(), ${} (command substitution)
    if (/[`\r\n]/.test(command) || /\$\(/.test(command) || /\$\{/.test(command)) {
      return { allowed: false, reason: "Blocked: shell metacharacters detected (backtick or command substitution)." };
    }
    // Block ; (sequential chaining) and single & (background) but allow && and ||
    if (/;/.test(command) || /(?<![&|])&(?![&|])/.test(command)) {
      return { allowed: false, reason: "Blocked: use && instead of ; for chaining, and don't background processes with &." };
    }
  }

  // Allow at most 5 pipes (e.g., `ls | grep foo | sort | head | cut`).
  const pipeCount = (command.match(/\|/g) || []).length;
  if (pipeCount > 5) {
    return {
      allowed: false,
      reason: `Blocked: too many pipes (${pipeCount}). Maximum 5 pipes allowed per command.`,
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
      };
    }
  }

  return { allowed: true, reason: "Shell command allowed" };
}
