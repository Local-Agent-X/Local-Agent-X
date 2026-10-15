#!/usr/bin/env node
/**
 * Vendored-code gate for src/broker-transport/vendor/: a copy of the agentxos repo's
 * wire protocol and broker client. The phone (agentxos-mobile) vendors the same files,
 * so a contract changed here alone breaks the phone without a compile error anywhere.
 *
 * The copy drifts two ways, and this catches both:
 *   1. Hand edits here. vendor/UPSTREAM.json records each file's upstream path and a hash
 *      of its CODE (comments, whitespace, quote style and import specifiers normalized
 *      away). A changed hash fails: change agentxos upstream and re-sync instead.
 *   2. Upstream moving on. When an agentxos checkout is found ($AGENTXOS_DIR, else the
 *      `agentxos` folder next to this repo), each file's code must equal its upstream
 *      file's code. Without a checkout (CI) this half is skipped, loudly.
 *
 *   --sync   copy every file from upstream (adapting import specifiers to Node16 ESM),
 *            then record the hashes. The only way vendor/ should change.
 *   --write  record the hashes of the files as they are.
 * Runs in `npm run build` (check:vendor-sync).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vendorDir = join(repoRoot, "src", "broker-transport", "vendor");
const manifestPath = join(vendorDir, "UPSTREAM.json");
const sync = process.argv.includes("--sync");
const write = sync || process.argv.includes("--write");

/** Code only: no comments, no whitespace, one quote style, and every module specifier
 *  reduced to its bare module name (`./protocol.js`, `@agentxos/protocol` and
 *  `../../protocol/src/index.ts` all become `protocol`). */
export function normalizeCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/(from\s*|import\s*\(\s*)["']([^"']+)["']/g, (_m, kw, spec) => `${kw}'${moduleName(spec)}'`)
    .replace(/"/g, "'")
    .replace(/\s+/g, "");
}

/** How upstream names the protocol package from the client package. */
const PROTOCOL_PACKAGE = /^(@agentxos\/protocol|(\.\.\/)+protocol\/src\/index\.ts)$/;

function moduleName(spec) {
  if (PROTOCOL_PACKAGE.test(spec)) return "protocol";
  const last = spec.split("/").pop() ?? spec;
  return last.replace(/\.(ts|js|mjs)$/, "");
}

/** Upstream specifiers → this repo's: `.ts` siblings become `.js` (Node16 ESM), and the
 *  protocol package (by alias or by path) becomes the vendored `./protocol.js`. */
function adaptImports(source) {
  return source
    .replace(/(from\s*|import\s*\(\s*)"([^"]+)"/g, (m, kw, spec) => (PROTOCOL_PACKAGE.test(spec) ? `${kw}"./protocol.js"` : m))
    .replace(/(from\s*|import\s*\(\s*)"(\.\/[^"]+)\.ts"/g, '$1"$2.js"');
}

const hashOf = (source) => createHash("sha256").update(normalizeCode(source)).digest("hex");

function findUpstream() {
  const candidates = [process.env.AGENTXOS_DIR, resolve(repoRoot, "..", "agentxos")].filter(Boolean);
  return candidates.find((dir) => existsSync(join(dir, "packages", "protocol"))) ?? null;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const upstreamDir = findUpstream();
const errors = [];

if (sync) {
  if (!upstreamDir) {
    console.error("check-vendor-sync --sync: no agentxos checkout found; set AGENTXOS_DIR");
    process.exit(1);
  }
  for (const [file, entry] of Object.entries(manifest.files)) {
    const up = join(upstreamDir, entry.upstream);
    if (!existsSync(up)) errors.push(`upstream ${entry.upstream} not found in ${upstreamDir}`);
    else writeFileSync(join(vendorDir, file), adaptImports(readFileSync(up, "utf-8")));
  }
}

for (const f of readdirSync(vendorDir).filter((f) => f.endsWith(".ts"))) {
  if (!manifest.files[f]) errors.push(`vendor/${f} is not listed in vendor/UPSTREAM.json`);
}

for (const [file, entry] of Object.entries(manifest.files)) {
  const local = join(vendorDir, file);
  if (!existsSync(local)) {
    errors.push(`vendor/UPSTREAM.json lists vendor/${file}, which does not exist`);
    continue;
  }
  const hash = hashOf(readFileSync(local, "utf-8"));
  if (write) entry.sha256 = hash;
  else if (hash !== entry.sha256) {
    errors.push(`vendor/${file} differs from the recorded copy of ${entry.upstream}: vendored files are never hand-edited. Change agentxos upstream, then run --sync`);
  }
}

if (upstreamDir) {
  for (const [file, entry] of Object.entries(manifest.files)) {
    const up = join(upstreamDir, entry.upstream);
    const local = join(vendorDir, file);
    if (!existsSync(up)) {
      errors.push(`upstream ${entry.upstream} not found in ${upstreamDir}`);
      continue;
    }
    if (existsSync(local) && normalizeCode(readFileSync(up, "utf-8")) !== normalizeCode(readFileSync(local, "utf-8"))) {
      errors.push(`vendor/${file} no longer matches upstream ${entry.upstream}: run --sync`);
    }
  }
}

if (write) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`check-vendor-sync: ${sync ? "copied and " : ""}recorded ${Object.keys(manifest.files).length} vendored files`);
}

if (errors.length > 0) {
  console.error("Vendored agentxos protocol is out of sync:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(
  `check-vendor-sync: OK (${Object.keys(manifest.files).length} files; ` +
    (upstreamDir ? `match agentxos upstream at ${upstreamDir})` : "upstream checkout not found, upstream comparison SKIPPED; set AGENTXOS_DIR to run it)"),
);
