// Best-effort shell lexing primitives shared by the shell-command detectors and
// policy engine: quote stripping, whitespace tokenization, command-separator
// segmentation, and executable-basename normalization. Pure string walks — no
// operator-precedence parsing, subshell, or backslash-escape handling — just
// enough to isolate command positions and inspect argv[0]/flags. Split out of
// shell-detectors.ts to keep that module under the 400-LOC ceiling;
// shell-detectors.ts re-exports the three primitives its callers import so no
// consumer import path changes.

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
