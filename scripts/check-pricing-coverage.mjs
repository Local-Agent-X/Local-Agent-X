/**
 * Build gate: every selectable model on a metered cloud provider must have an
 * EXACT rate in src/cost-tracker.ts PRICING. Without this, a real model that
 * isn't in the table silently prefix-matches the wrong tier (or the $3 default)
 * and is mis-billed — exactly the grok-4.3 bug ($1.25/$2.50 charged as $3/$15).
 * Adding a model to the registry without its price now fails the build.
 *
 * Also WARNS (doesn't fail) when the rate table hasn't been re-verified within
 * the staleness window — the nudge a hardcoded table needs, since it can't know
 * a provider repriced an existing model.
 *
 * Parses the source text (no imports) so it's fast and side-effect-free, the
 * same shape as gen-codebase-map.mjs. Run via `npm run check:pricing-coverage`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Providers that bill per token AND have a canonical public rate. local /
// cerebras / ollama-cloud / custom are OSS / dynamic / user-defined endpoints
// with no single authoritative rate, so they're exempt (priced best-effort).
const METERED = ["xai", "openai", "codex", "anthropic", "gemini"];
const STALE_DAYS = 90;

const registry = readFileSync(join(root, "src/providers/registry.ts"), "utf8");
const costTracker = readFileSync(join(root, "src/cost-tracker.ts"), "utf8");
const modelWindows = readFileSync(join(root, "src/context-manager/model-windows.ts"), "utf8");

// Exact PRICING keys: lines like  "model-id": { input: ...
const priced = new Set();
for (const m of costTracker.matchAll(/^\s*["']([^"']+)["']:\s*\{\s*input:/gm)) priced.add(m[1]);

const verifiedAt = (costTracker.match(/PRICES_VERIFIED_AT\s*=\s*["']([^"']+)["']/) || [])[1];

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

// Per metered provider, pull models[] + defaultModel + backgroundModel. Provider
// blocks sit at 2-space indent and close with "\n  },"; inner objects are inline
// or deeper-indented, so that boundary isolates one provider.
function modelsFor(id) {
  let block = (registry.match(new RegExp(`\\n  ${id}:\\s*\\{([\\s\\S]*?)\\n  \\},`)) || [])[1] || "";
  // Strip line comments first — apostrophes in prose ("whatever's") otherwise
  // read as quoted strings. Model IDs are always double-quoted.
  block = block.replace(/\/\/[^\n]*/g, "");
  const out = new Set();
  const arr = block.match(/models:\s*\[([\s\S]*?)\]/);
  if (arr) for (const s of arr[1].matchAll(/"([^"]+)"/g)) out.add(s[1]);
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
  console.error("check-pricing-coverage: FAIL — metered models with no exact price in src/cost-tracker.ts PRICING:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("\nAdd each model's real rate to PRICING (verify against the provider's pricing page), then bump PRICES_VERIFIED_AT.");
  process.exit(1);
}

const verifiedMs = verifiedAt ? Date.parse(`${verifiedAt}T00:00:00Z`) : NaN;
const ageDays = Number.isFinite(verifiedMs) ? Math.floor((Date.now() - verifiedMs) / 86_400_000) : NaN;
if (!Number.isFinite(verifiedMs)) {
  console.warn("check-pricing-coverage: WARN — PRICES_VERIFIED_AT missing/unparseable in src/cost-tracker.ts.");
} else if (ageDays > STALE_DAYS) {
  console.warn(
    `check-pricing-coverage: WARN — rates last verified ${ageDays}d ago (>${STALE_DAYS}d). Re-check provider pricing pages and bump PRICES_VERIFIED_AT in src/cost-tracker.ts.`,
  );
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
console.log(
  `check-pricing-coverage: OK (${total} metered models priced, ${ctxCovered}/${total} with exact context window, verified ${verifiedAt ?? "unknown"})`,
);
