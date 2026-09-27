/**
 * Recheck src/pricing/model-prices.ts against LiteLLM's MIT-licensed price file
 * (per-token USD, keyed by model id). Pure functions over source TEXT plus one
 * fetch helper — dependency-free, so CI can run it without `npm ci`, and the
 * comparison is unit-tested against a fixture (test/pricing-drift.test.ts).
 *
 * Only FIRST-PARTY entries count: a reseller (bedrock, vertex, azure,
 * openrouter, …) prices the same model with its own markup or region uplift,
 * so matching one would report drift that isn't ours. A row with no confident
 * first-party match stays on the PRICES_VERIFIED_AT date check.
 */

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** litellm_provider values that ARE the vendor we bill through. Cerebras is
 *  here because it is the provider our gpt-oss / GLM rows are billed on. */
export const FIRST_PARTY_PROVIDERS = ["anthropic", "openai", "gemini", "xai", "cerebras"];

/** Relative tolerance — the source stores floats like 2e-07, so 0.2/1e6 must
 *  equal it without an exact-bit comparison. */
const REL_EPSILON = 1e-6;

const ROW_ID_RE = /^\s*"([^"]+)":\s*\{/;

/** The PRICING object literal's body, so other `{ … }` lines in the module
 *  (the ModelPricing interface) are never read as rows. */
function pricingBlock(text) {
  const start = text.search(/export const PRICING\b[^=]*=\s*\{/);
  if (start < 0) return { start: -1, end: -1 };
  const end = text.indexOf("\n};", start);
  return { start, end: end < 0 ? text.length : end };
}

/** Rows of the PRICING table: [{ id, input, output, cacheRead? }]. */
export function parsePriceRows(text) {
  const { start, end } = pricingBlock(text);
  if (start < 0) return [];
  const rows = [];
  for (const line of text.slice(start, end).split("\n")) {
    const id = line.match(ROW_ID_RE)?.[1];
    const body = line.match(/\{([^}]*)\}/)?.[1];
    if (!id || body === undefined) continue;
    const row = { id };
    for (const f of body.matchAll(/(\w+):\s*([0-9.eE+-]+)/g)) row[f[1]] = Number(f[2]);
    if (typeof row.input === "number" && typeof row.output === "number") rows.push(row);
  }
  return rows;
}

/** CACHE_READ_MULTIPLIER — the cache-read rate a row without `cacheRead` bills at. */
export function parseDefaultCacheRead(text) {
  const m = text.match(/CACHE_READ_MULTIPLIER\s*=\s*([0-9.]+)/);
  return m ? Number(m[1]) : NaN;
}

export function sameRate(a, b, eps = REL_EPSILON) {
  return Math.abs(a - b) <= eps * Math.max(Math.abs(a), Math.abs(b));
}

/** Per-token USD → our per-1M-token unit, rounded off float noise (4e-06 → 4). */
export function perMillion(perToken) {
  return Number((perToken * 1_000_000).toFixed(6));
}

function sourceRates(entry) {
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  const read = entry.cache_read_input_token_cost;
  return {
    input: perMillion(input),
    output: perMillion(output),
    // Our cacheRead is a MULTIPLIER on input, the source's an absolute rate.
    cacheRead: typeof read === "number" && input > 0 ? Number((read / input).toFixed(6)) : undefined,
  };
}

function isPricedFirstParty(entry) {
  return !!entry
    && FIRST_PARTY_PROVIDERS.includes(entry.litellm_provider)
    && typeof entry.input_cost_per_token === "number"
    && typeof entry.output_cost_per_token === "number";
}

/** The first-party entry for our model id: the plain key (anthropic / openai
 *  list plain ids) or `<provider>/<id>` (xai/, gemini/, cerebras/). Returns
 *  null when there is none, or `{ ambiguous }` when two first-party entries
 *  disagree — neither is a confident match then. */
export function findSourceEntry(source, id) {
  const keys = [id, ...FIRST_PARTY_PROVIDERS.map((p) => `${p}/${id}`)]
    .filter((k) => Object.prototype.hasOwnProperty.call(source, k) && isPricedFirstParty(source[k]));
  if (keys.length === 0) return null;
  const first = sourceRates(source[keys[0]]);
  for (const k of keys.slice(1)) {
    const r = sourceRates(source[k]);
    const agree = sameRate(r.input, first.input) && sameRate(r.output, first.output)
      && (r.cacheRead === undefined || first.cacheRead === undefined || sameRate(r.cacheRead, first.cacheRead));
    if (!agree) return { ambiguous: keys };
  }
  return { key: keys[0], rates: first };
}

/**
 * Compare every row against the source. Returns
 *   matched:   [{ id, key }]                     rows the source confirms
 *   drift:     [{ id, key, fields: [{ field, ours, theirs }], proposed }]
 *   unmatched: [{ id, reason }]                  rows left to the date check
 * `proposed` is the row as the source prices it — what `--apply` writes.
 */
export function comparePrices(rows, source, defaultCacheRead) {
  const matched = [];
  const drift = [];
  const unmatched = [];
  for (const row of rows) {
    if (row.input === 0 && row.output === 0) {
      unmatched.push({ id: row.id, reason: "local (free)" });
      continue;
    }
    const hit = findSourceEntry(source, row.id);
    if (!hit) {
      unmatched.push({ id: row.id, reason: "no first-party entry" });
      continue;
    }
    if (hit.ambiguous) {
      unmatched.push({ id: row.id, reason: `first-party entries disagree (${hit.ambiguous.join(", ")})` });
      continue;
    }
    const theirs = hit.rates;
    const oursCacheRead = row.cacheRead ?? defaultCacheRead;
    const fields = [];
    if (!sameRate(row.input, theirs.input)) fields.push({ field: "input", ours: row.input, theirs: theirs.input });
    if (!sameRate(row.output, theirs.output)) fields.push({ field: "output", ours: row.output, theirs: theirs.output });
    if (theirs.cacheRead !== undefined && !sameRate(oursCacheRead, theirs.cacheRead)) {
      fields.push({ field: "cacheRead", ours: oursCacheRead, theirs: theirs.cacheRead });
    }
    if (fields.length === 0) {
      matched.push({ id: row.id, key: hit.key });
      continue;
    }
    // A cacheRead equal to the default multiplier is left off the row, as the
    // table does today; a source with no cache rate keeps whatever we had.
    const cacheRead = theirs.cacheRead === undefined
      ? row.cacheRead
      : sameRate(theirs.cacheRead, defaultCacheRead) ? undefined : theirs.cacheRead;
    drift.push({
      id: row.id,
      key: hit.key,
      fields,
      proposed: { input: theirs.input, output: theirs.output, ...(cacheRead !== undefined ? { cacheRead } : {}) },
    });
  }
  return { matched, drift, unmatched };
}

export function formatPricing(p) {
  return `{ input: ${p.input}, output: ${p.output}${p.cacheRead !== undefined ? `, cacheRead: ${p.cacheRead}` : ""} }`;
}

/** Rewrite each drifted row's `{ … }` literal in place; the key, indentation
 *  and any trailing comment on the line are kept for the reviewer to judge. */
export function applyDrift(text, drift) {
  const byId = new Map(drift.map((d) => [d.id, d.proposed]));
  const { start, end } = pricingBlock(text);
  if (start < 0 || byId.size === 0) return text;
  const block = text.slice(start, end).split("\n").map((line) => {
    const id = line.match(ROW_ID_RE)?.[1];
    return id && byId.has(id) ? line.replace(/\{[^}]*\}/, formatPricing(byId.get(id))) : line;
  });
  return text.slice(0, start) + block.join("\n") + text.slice(end);
}

/** GET the price file with a hard timeout (the signal also bounds the body
 *  read). Throws on any failure — the caller decides what offline means. */
export async function fetchPriceSource(url = LITELLM_PRICES_URL, timeoutMs = 8_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("unexpected price-file shape");
  return data;
}
