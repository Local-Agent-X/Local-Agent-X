#!/usr/bin/env node
/**
 * Two source-hygiene gates, run first in `npm run build`:
 *
 * 1. No raw exotic code points in shipped source.
 *
 *    a. U+2028 / U+2029 are JS *line terminators*; a raw one inside a regex
 *       literal compiles past `tsc` but throws "Invalid regular expression:
 *       missing /" the instant V8 parses the emitted file — which bricked the
 *       desktop main process before any window or splash could load. Use the
 *       backslash-u escape forms instead. Test files are exempt: they
 *       legitimately feed these code points as data inside string literals,
 *       where ES2019+ permits them.
 *
 *    b. No raw control code points: C0 except tab/LF/CR, plus DEL and the C1
 *       block. These are legal SourceCharacters, so `tsc`, vitest and the
 *       bundler all stay green while the source rots underneath them. The
 *       shared harm is that they are invisible in review: a reviewer sees
 *       `join("")` and cannot tell it from `join("x")`. U+0000 is worse
 *       again — it is the one git's binary heuristic keys on, so `git show`
 *       renders every future diff as "Bin 6514 -> 6515 bytes", `grep -rn`
 *       exits 1 without printing the line, and `file` reports the source as
 *       `data`. The rest of C0/DEL/C1 still diff and grep normally; they are
 *       banned because nobody types them on purpose and nobody can see them.
 *       The backslash-u escape the message points at is identical at runtime,
 *       so the gate constrains representation and never intent — with one
 *       exception worth knowing: inside String.raw or a tagged template's
 *       .raw, the escape is NOT unescaped, so a raw byte there must be built
 *       with String.fromCharCode instead.
 *
 *       This half has no test exemption, because a binary test file is just
 *       as unreviewable. That is affordable only because ROOTS excludes
 *       test/: test/browser-layout-report-script.test.ts:611 feeds a raw
 *       U+0001 to a sanitizer on purpose. There is no ignore-comment
 *       mechanism and GRANDFATHERED covers only the LOC gate, so widening
 *       ROOTS to test/ is a breaking change — it would need an escape hatch
 *       or that line rewritten via String.fromCharCode first.
 *
 *    c. No raw bidi overrides (U+202A-U+202E, U+2066-U+2069) in non-test
 *       source. These reorder how a line RENDERS without changing what it
 *       EXECUTES, which is the trojan-source attack: a reviewer approves one
 *       program and the compiler builds another. Unlike (b) this is a
 *       security property, not a legibility one, so it takes the same test
 *       exemption as (a) — src/security/secrets/secret-scanner.test.ts is
 *       the scanner's own fixture set and holds the tree's only five such
 *       lines, all in tests, so non-test source is clean today.
 *
 *    Deliberately NOT banned: the zero-width characters (U+200B-U+200F,
 *    U+FEFF). Unlike bidi they carry no rendering-vs-execution mismatch, and
 *    they have real raw uses in non-test source here — an emoji ZWJ sequence
 *    in src/agent-store/template-defaults.ts:166, and the character sets of
 *    the sanitizers that strip them in src/tools/web-fetch.ts:137 and
 *    src/tools/shared/office-preview.ts:36. Banning them would flip the
 *    build red rather than catch a bug.
 *
 *    (This file builds U+2028/U+2029 via String.fromCharCode and matches the
 *    control and bidi ranges with backslash-u escapes, so its own source is
 *    itself clean under every rule above.)
 *
 * 2. No NEW file over 400 LOC. The repo standard is one responsibility
 *    per file; god files get split. Existing oversized files are
 *    grandfathered below as known debt (burn down via /refactor-godfiles)
 *    — the gate's job is to stop the list from growing, not to flip the
 *    build red on day one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["src", "desktop/src", "public/js"];
const MAX_LOC = 400;
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
// C0 except tab (0009), LF (000A) and CR (000D), then DEL (007F) and C1.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const CONTROL_ALL = new RegExp(CONTROL.source, "g");
// Bidi overrides and isolates: they reorder rendering, not execution.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
const BIDI_ALL = new RegExp(BIDI.source, "g");

// Oversized files that predate the LOC gate. Do not add to this list to
// silence the gate — split the file instead.
const GRANDFATHERED = new Set([]);

const baseName = (rel) => rel.split("/").pop();
const isTest = (rel) => /\.test\.(ts|js)$/.test(baseName(rel));
const isSource = (name) => /\.(ts|tsx|js|mjs|cjs)$/.test(name) && !name.endsWith(".d.ts");
const nameOf = (ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
const found = (line, re) => [...new Set(line.match(re) ?? [])].map(nameOf).sort();

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (isSource(name)) out.push(p);
  }
  return out;
}

function countLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/**
 * Gate 1 for a single file: every raw exotic code point in `text`, reported
 * as "path:line  what — fix". One pass over the lines, both checks together.
 */
export function exoticCodePointErrors(rel, text, { test = false } = {}) {
  const errors = [];
  const hasSep = !test && (text.includes(LINE_SEP) || text.includes(PARA_SEP));
  const hasControl = CONTROL.test(text);
  const hasBidi = !test && BIDI.test(text);
  if (!hasSep && !hasControl && !hasBidi) return errors;

  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (hasSep && (line.includes(LINE_SEP) || line.includes(PARA_SEP))) {
      errors.push(`${rel}:${i + 1}  raw U+2028/U+2029 — use the backslash-u escape`);
    }
    if (hasControl) {
      const hits = found(line, CONTROL_ALL);
      if (hits.length) {
        errors.push(`${rel}:${i + 1}  raw control code point ${hits.join(", ")} — use the backslash-u escape`);
      }
    }
    if (hasBidi) {
      const hits = found(line, BIDI_ALL);
      if (hits.length) {
        errors.push(`${rel}:${i + 1}  raw bidi override ${hits.join(", ")} — this line renders unlike it executes; use the backslash-u escape`);
      }
    }
  });
  return errors;
}

function main() {
  const files = ROOTS.flatMap((r) => walk(join(repoRoot, r)));
  const charErrors = [];
  const locErrors = [];

  for (const file of files) {
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    const text = readFileSync(file, "utf-8");
    const test = isTest(rel);

    charErrors.push(...exoticCodePointErrors(rel, text, { test }));

    if (!test && !GRANDFATHERED.has(rel)) {
      const n = countLines(text);
      if (n > MAX_LOC) locErrors.push(`${rel}  ${n} LOC (max ${MAX_LOC}) — split it`);
    }
  }

  let failed = false;
  if (charErrors.length) {
    failed = true;
    console.error("Raw exotic code points in source:");
    for (const e of charErrors) console.error("  " + e);
  }
  if (locErrors.length) {
    failed = true;
    console.error(`Files over ${MAX_LOC} LOC (not grandfathered):`);
    for (const e of locErrors) console.error("  " + e);
  }
  if (failed) process.exit(1);
  console.log(`check-source-hygiene: OK (${files.length} files; ${GRANDFATHERED.size} grandfathered)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
