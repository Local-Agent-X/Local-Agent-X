/**
 * Build gate: every selectable model on a metered cloud provider must have an
 * EXACT rate in src/pricing/model-prices.ts PRICING. Without this, a real model that
 * isn't in the table silently prefix-matches the wrong tier (or the $3 default)
 * and is mis-billed — exactly the grok-4.3 bug ($1.25/$2.50 charged as $3/$15).
 * Adding a model to the registry without its price now fails the build.
 *
 * Also rechecks every row it can match against LiteLLM's price file
 * (scripts/pricing-drift.mjs) and WARNS on drift; rows it can't match keep the
 * date check — a WARN once PRICES_VERIFIED_AT is past the staleness window.
 * Offline, every row falls back to the date check; the build never fails or
 * hangs on the network (8s timeout).
 *   --strict  exit non-zero on drift or an unreachable price file (the weekly
 *             CI job; a red run is the alert). The build stays warn-only.
 *   --apply   rewrite drifted rows in src/pricing/model-prices.ts in place, for
 *             a developer to review and commit. Never used by the build.
 *
 * Parses the source text (no imports) so it's fast and side-effect-free, the
 * same shape as gen-codebase-map.mjs. Run via `npm run check:pricing-coverage`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  applyDrift, comparePrices, fetchPriceSource, parseDefaultCacheRead, parsePriceRows, LITELLM_PRICES_URL,
} from "./pricing-drift.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const APPLY = process.argv.includes("--apply");
const PRICE_FILE = "src/pricing/model-prices.ts";

// Providers that bill per token AND have a canonical public rate. local /
// cerebras / ollama-cloud / custom are OSS / dynamic / user-defined endpoints
// with no single authoritative rate, so they're exempt (priced best-effort).
const METERED = ["xai", "openai", "codex", "anthropic", "anthropic-api", "gemini"];
const STALE_DAYS = 90;

const registry = readFileSync(join(root, "src/providers/registry.ts"), "utf8");
const priceTable = readFileSync(join(root, PRICE_FILE), "utf8");
const modelWindows = readFileSync(join(root, "src/context-manager/model-windows.ts"), "utf8");

// Exact PRICING keys: lines like  "model-id": { input: ...
const priced = new Set();
for (const m of priceTable.matchAll(/^\s*["']([^"']+)["']:\s*\{\s*input:/gm)) priced.add(m[1]);

const verifiedAt = (priceTable.match(/PRICES_VERIFIED_AT\s*=\s*["']([^"']+)["']/) || [])[1];

// Exact MODEL_CONTEXTS keys from src/context-manager/model-windows.ts. A missing
// key isn't fatal (lookupContextWindow substring-falls-back to a safe default),
// so this feeds a WARN, not the FAIL above.
const ctxKeys = new Set();
const ctxBlockMatch = modelWindows.match(/const MODEL_CONTEXTS[^=]*=\s*\{([\s\S]*?)\n\};/);
if (ctxBlockMatch) {
  // Strip line comments first so commented-out model names aren't counted.
  const ctxBlock = ctxBlockMatch[1].replace(/\/\/[^\n]*/g, "");
  for (const m of ctxBlock.matchAll(/^\s*["']([^"']+)["']\s*:/gm)) ctxKeys.add(m[1]);
}

// Shared model arrays declared above PROVIDERS (`const NAME_MODELS = [...]`)
// and spread into entries as `models: [...NAME_MODELS]`.
const sharedModelLists = new Map();
for (const m of registry.matchAll(/const (\w+_MODELS)\s*=\s*\[([\s\S]*?)\];/g)) {
  sharedModelLists.set(m[1], [...m[2].replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((s) => s[1]));
}

// Per metered provider, pull models[] + defaultModel + backgroundModel. Provider
// blocks sit at 2-space indent and close with "\n  },"; inner objects are inline
// or deeper-indented, so that boundary isolates one provider. Hyphenated ids
// are quoted keys ("anthropic-api": {).
function modelsFor(id) {
  let block = (registry.match(new RegExp(`\\n  "?${id}"?:\\s*\\{([\\s\\S]*?)\\n  \\},`)) || [])[1] || "";
  // Strip line comments first — apostrophes in prose ("whatever's") otherwise
  // read as quoted strings. Model IDs are always double-quoted.
  block = block.replace(/\/\/[^\n]*/g, "");
  const out = new Set();
  const arr = block.match(/models:\s*\[([\s\S]*?)\]/);
  if (arr) {
    for (const s of arr[1].matchAll(/"([^"]+)"/g)) out.add(s[1]);
    for (const spread of arr[1].matchAll(/\.\.\.(\w+_MODELS)/g)) for (const s of sharedModelLists.get(spread[1]) ?? []) out.add(s);
  }
  for (const key of ["defaultModel", "backgroundModel"]) {
    const m = block.match(new RegExp(`${key}:\\s*"([^"]+)"`));
    if (m && m[1]) out.add(m[1]);
  }
  return [...out];
}

const missing = [];
const ctxMissing = [];
let total = 0;
for (const id of METERED) {
  for (const model of modelsFor(id)) {
    total++;
    if (!priced.has(model)) missing.push(`${id}: ${model}`);
    if (!ctxKeys.has(model)) ctxMissing.push(`${id}: ${model}`);
  }
}

if (total === 0) {
  console.error("check-pricing-coverage: FAIL — parsed 0 models (registry shape changed? update this script).");
  process.exit(1);
}

if (missing.length > 0) {
  console.error("check-pricing-coverage: FAIL — metered models with no exact price in src/pricing/model-prices.ts PRICING:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("\nAdd each model's real rate to PRICING (verify against the provider's pricing page), then bump PRICES_VERIFIED_AT.");
  process.exit(1);
}

const verifiedMs = verifiedAt ? Date.parse(`${verifiedAt}T00:00:00Z`) : NaN;
const ageDays = Number.isFinite(verifiedMs) ? Math.floor((Date.now() - verifiedMs) / 86_400_000) : NaN;
const stale = Number.isFinite(verifiedMs) && ageDays > STALE_DAYS;
if (!Number.isFinite(verifiedMs)) {
  console.warn("check-pricing-coverage: WARN — PRICES_VERIFIED_AT missing/unparseable in src/pricing/model-prices.ts.");
}

// Rate recheck. Offline, the date check covers every row, exactly as before.
let source = null;
try {
  source = await fetchPriceSource();
} catch (err) {
  console.warn(`check-pricing-coverage: WARN — could not fetch ${LITELLM_PRICES_URL} (${err?.message ?? err}); rates are date-checked only.`);
}

let rateSummary = "LiteLLM unreachable";
let rateFailure = !source;
if (!source) {
  if (stale) {
    console.warn(
      `check-pricing-coverage: WARN — rates last verified ${ageDays}d ago (>${STALE_DAYS}d). Re-check provider pricing pages and bump PRICES_VERIFIED_AT in src/pricing/model-prices.ts.`,
    );
  }
} else {
  const { matched, drift, unmatched } = comparePrices(parsePriceRows(priceTable), source, parseDefaultCacheRead(priceTable));
  for (const d of drift) {
    for (const f of d.fields) {
      console.warn(`check-pricing-coverage: DRIFT — ${d.id} ${f.field}: ours ${f.ours}, LiteLLM ${f.theirs} (source key "${d.key}")`);
    }
  }
  if (drift.length > 0 && !APPLY) {
    console.warn("  Confirm on the provider's pricing page; `node scripts/check-pricing-coverage.mjs --apply` rewrites the drifted rows for review.");
  }
  if (stale && unmatched.length > 0) {
    console.warn(
      `check-pricing-coverage: WARN — ${unmatched.length} rows have no confident LiteLLM match and were last verified ${ageDays}d ago (>${STALE_DAYS}d): ${unmatched.map((u) => u.id).join(", ")}. Re-check provider pricing pages and bump PRICES_VERIFIED_AT in ${PRICE_FILE}.`,
    );
  }
  if (APPLY && drift.length > 0) {
    writeFileSync(join(root, PRICE_FILE), applyDrift(priceTable, drift));
    console.log(`check-pricing-coverage: rewrote ${drift.length} drifted rows in ${PRICE_FILE} — review the diff before committing.`);
  }
  rateFailure = drift.length > 0;
  rateSummary = `${matched.length} rates match LiteLLM, ${drift.length} drifted, ${unmatched.length} date-checked`;
}

// Context-window coverage: WARN-only. lookupContextWindow substring-falls-back
// to a safe default for an unknown model, so a missing key is a nudge to add an
// exact entry, not a build-breaker.
if (ctxMissing.length > 0) {
  console.warn("check-pricing-coverage: WARN — metered models with no exact context window in src/context-manager/model-windows.ts MODEL_CONTEXTS:");
  for (const m of ctxMissing) console.warn(`  - ${m}`);
  console.warn("\nAdd each model's window to MODEL_CONTEXTS (lookupContextWindow's substring fallback still applies, so this is a WARN, not a failure).");
}

const ctxCovered = total - ctxMissing.length;
const failed = rateFailure && (STRICT || (APPLY && !source));
console.log(
  `check-pricing-coverage: ${failed ? "FAIL" : "OK"} (${total} metered models priced, ${ctxCovered}/${total} with exact context window, ${rateSummary}, verified ${verifiedAt ?? "unknown"})`,
);
if (failed) process.exit(1);
