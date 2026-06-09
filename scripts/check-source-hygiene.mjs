#!/usr/bin/env node
/**
 * Two source-hygiene gates, run first in `npm run build`:
 *
 * 1. No raw U+2028 / U+2029 in shipped source. These code points are JS
 *    *line terminators*; a raw one inside a regex literal compiles past
 *    `tsc` but throws "Invalid regular expression: missing /" the instant
 *    V8 parses the emitted file — which bricked the desktop main process
 *    before any window or splash could load. Use the backslash-u escape
 *    forms instead. Test files are exempt: they legitimately feed these
 *    code points as data inside string literals, where ES2019+ permits
 *    them. (This file builds the chars via String.fromCharCode so its own
 *    source stays pure ASCII.)
 *
 * 2. No NEW file over 400 LOC. The repo standard is one responsibility
 *    per file; god files get split. Existing oversized files are
 *    grandfathered below as known debt (burn down via /refactor-godfiles)
 *    — the gate's job is to stop the list from growing, not to flip the
 *    build red on day one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["src", "desktop/src", "public/js"];
const MAX_LOC = 400;
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

// Oversized files that predate the LOC gate. Do not add to this list to
// silence the gate — split the file instead.
const GRANDFATHERED = new Set([
  "src/security/layer-core.ts",
  "src/threat/threat-engine.ts",
  "src/self-edit-sandbox.ts",
  "src/sanitize.ts",
  "desktop/src/main.ts",
  "public/js/chat-dictate.js",
  "public/js/apps-ide.js",
  "public/js/settings-onboarding.js",
  "public/js/chat-render.js",
  "public/js/chat-status-bar.js",
  "public/js/chat-stream-store.js",
  "public/js/chat-agent-feeds.js",
]);

const baseName = (rel) => rel.split("/").pop();
const isTest = (rel) => /\.test\.(ts|js)$/.test(baseName(rel));
const isSource = (name) => /\.(ts|tsx|js|mjs|cjs)$/.test(name) && !name.endsWith(".d.ts");

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

const files = ROOTS.flatMap((r) => walk(join(repoRoot, r)));
const sepErrors = [];
const locErrors = [];

for (const file of files) {
  const rel = relative(repoRoot, file).replace(/\\/g, "/");
  const text = readFileSync(file, "utf-8");
  const test = isTest(rel);

  if (!test && (text.includes(LINE_SEP) || text.includes(PARA_SEP))) {
    text.split(/\r\n|\r|\n/).forEach((line, i) => {
      if (line.includes(LINE_SEP) || line.includes(PARA_SEP)) {
        sepErrors.push(`${rel}:${i + 1}  raw U+2028/U+2029 — use the backslash-u escape`);
      }
    });
  }

  if (!test && !GRANDFATHERED.has(rel)) {
    const n = countLines(text);
    if (n > MAX_LOC) locErrors.push(`${rel}  ${n} LOC (max ${MAX_LOC}) — split it`);
  }
}

let failed = false;
if (sepErrors.length) {
  failed = true;
  console.error("Raw line/paragraph separators in source:");
  for (const e of sepErrors) console.error("  " + e);
}
if (locErrors.length) {
  failed = true;
  console.error(`Files over ${MAX_LOC} LOC (not grandfathered):`);
  for (const e of locErrors) console.error("  " + e);
}
if (failed) process.exit(1);
console.log(`check-source-hygiene: OK (${files.length} files; ${GRANDFATHERED.size} grandfathered)`);
