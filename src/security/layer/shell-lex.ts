// Best-effort shell lexing primitives shared by the shell-command detectors and
// policy engine: quote stripping, whitespace tokenization, command-separator
// segmentation, executable-basename normalization, and effective-argv[0]
// resolution (keyword/wrapper stripping). Pure string walks — no
// operator-precedence parsing, subshell, or backslash-escape handling — just
// enough to isolate command positions and inspect argv[0]/flags. Split out of
// shell-detectors.ts to keep that module under the 400-LOC ceiling;
// shell-detectors.ts re-exports the three primitives its callers import so no
// consumer import path changes.

import { SHELL_KEYWORD_PREFIXES, SHELL_WRAPPER_PREFIXES, WRAPPER_VALUE_OPTIONS } from "./shell-rules.js";

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

// Split a command into its top-level shell segments on the separators that
// start a NEW command: `|`, `;`, `&&`, `||`, `&`, and a raw newline. Quote-aware
// (mirrors tokenizeCommand's quote-state walk) so a separator LITERAL inside a
// quoted span is not a split point — `echo "a; b"` and `git commit -m "x; y"`
// each stay ONE segment. Used by the write-ban inline-eval scan so a chained
// interpreter (`echo hi; python -c "…"`, `true && python -c "…"`, a
// newline-chained pair) can't escape by hiding behind a non-`|` separator.
// Best-effort like the rest of this module: no operator-precedence parsing,
// subshell/backslash-escape handling — enough to isolate each command position.
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const next = command[i + 1];
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
      segments.push(cur);
      cur = "";
      i++; // consume the second operator char
      continue;
    }
    if (c === "|" || c === ";" || c === "&" || c === "\n") {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return segments;
}

// The basename of an executable token, lowercased, with any path prefix and a
// trailing Windows .exe removed. `/usr/bin/perl` → "perl", `Ruby.EXE` → "ruby".
// The python family collapses to a bare "python": `pythonw`, `python2`,
// `python3`, `python3.12`, `python.exe` all run the same inline `-c` eval, so
// the INTERP_EVAL_FLAGS table (keyed on "python") must match every spelling —
// otherwise `python3.12 -c "…"` / `pythonw -c "…"` escape the write-ban form
// refusal. Behavior-neutral for the other detectors: no python spelling appears
// in NETWORK_CLIENT_BINS / DANGEROUS_INVOKE_BINS / INTERP_ESCAPE_BINS.
export function execBasename(token: string): string {
  const base = token.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "");
  if (/^python(?:w|\d+(?:\.\d+)*)?$/.test(base)) return "python";
  return base;
}

// A duration/number positional (`timeout 30s`, `nice 10`) or a `VAR=val`
// assignment (`env NODE_ENV=prod`) — a wrapper arg that can never be a command
// name, so consuming it can't hide a real invocation.
function isPositionalWrapperArg(t: string): boolean {
  return /^\d+(\.\d+)?[smhd]?$/.test(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
}

// Resolve a segment's REAL command basename by skipping leading shell keywords
// (then/do/else/elif) and command-modifier wrappers (env/time/xargs/timeout/…),
// then returning the basename of the first genuine command word (null if the
// segment is only keywords/wrappers). Keeps `then dig`, `env dig`, `timeout 5
// dig`, `xargs -I {} dig` resolving to the real bin so the argv[0] scans
// (detectNetworkClientArgv0 / detectDangerousInvokeBin) DENY them once
// separators are relaxed under a confined backend.
//
// A wrapper's own args are skipped PRECISELY (not "skip until a non-flag"): a
// SHORT option that takes a DETACHED value (WRAPPER_VALUE_OPTIONS — `xargs -I
// {}`, `env -u NAME`, `timeout -s TERM`) consumes the option AND its value
// token, so the value ({} / NAME / TERM) isn't mistaken for the command; a
// glued `-I{}` / `-n10` / `-oL`, a no-value flag, a long `--preserve-status`, a
// duration/number positional, and `VAR=val` each consume just themselves; `--`
// ends option processing. This bounded map is why `time grep host /etc/hosts`
// stays ALLOWED (grep is the argv[0]; host is never reached) — a "scan every
// token" approach would false-block it on the dictionary word `host`.
//
// KNOWN LIMITATION (parked — NOT fully closable by string parsing): the
// argv[0]-only bins (dig/host/nslookup/getent/traceroute/mail + network
// clients) have no raw-string denylist backstop, so a wrapper/quoting/PATH
// trick can still evade — `\dig`, an unlisted busybox applet, a binary renamed
// on PATH, a long option with a detached value, or `sh -c "dig …"` whose `-c`
// body is a deliberately opaque quoted token (out of scope by design). The
// durable fix for egress under confinement is NETWORK-LAYER egress control at
// the sandbox/proxy, not shell parsing; this closes the realistic keyword/
// wrapper forms, not the ungameable general case.
export function resolveRealArgv0(tokens: string[]): string | null {
  let i = 0;
  while (i < tokens.length) {
    const base = execBasename(tokens[i]);
    if (SHELL_KEYWORD_PREFIXES.has(base)) {
      i++; // a keyword takes no args; the next token is the command position
      continue;
    }
    if (SHELL_WRAPPER_PREFIXES.has(base)) {
      const valueOpts = WRAPPER_VALUE_OPTIONS[base];
      i++;
      while (i < tokens.length) {
        const t = tokens[i];
        if (t === "--") { i++; break; } // end of options; next token is argv[0]
        if (t.startsWith("-")) {
          // Exact `-X` form of a value-taking option → also eat its detached
          // value. Glued (`-I{}`/`-n10`/`-oL`), no-value, and long options
          // carry no separate value token, so eat only the option itself.
          i += valueOpts && /^-[A-Za-z]$/.test(t) && valueOpts.has(t) ? 2 : 1;
          continue;
        }
        if (isPositionalWrapperArg(t)) { i++; continue; }
        break; // a real command word
      }
      continue;
    }
    return base;
  }
  return null;
}
