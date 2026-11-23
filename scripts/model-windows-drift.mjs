/**
 * Recheck src/context-manager/model-windows.ts MODEL_CONTEXTS against LiteLLM's
 * model file (the same file pricing-drift.mjs reads: it carries
 * max_input_tokens / max_output_tokens per model), and report models the
 * providers LAX supports list upstream that LAX does not. Pure functions over
 * source TEXT — dependency-free so CI runs it without `npm ci` — unit-tested
 * against a fixture (test/model-windows-drift.test.ts).
 *
 * Only FIRST-PARTY entries count (see FIRST_PARTY_PROVIDERS in
 * pricing-drift.mjs): a reseller's row can carry its own window.
 *
 * LiteLLM is a mirror, the provider's docs are the truth: a row whose line
 * comment carries `pin:` (with the provider's figure and the date it was read)
 * is reported as pinned, never as drift, and `--apply` leaves it alone.
 */
import { FIRST_PARTY_PROVIDERS } from "./pricing-drift.mjs";

// Groups: indent, id, number, trailing comment, the line's own CR (CRLF files).
const ROW_RE = /^(\s*)"([^"]+)":\s*([0-9_]+)\s*,?(\s*\/\/[^\r\n]*)?(\r?)$/;

/** The MODEL_CONTEXTS object literal's body. */
function windowBlock(text) {
  const start = text.search(/const MODEL_CONTEXTS\b[^=]*=\s*\{/);
  if (start < 0) return { start: -1, end: -1 };
  const end = text.indexOf("\n};", start);
  return { start, end: end < 0 ? text.length : end };
}

/** Rows of MODEL_CONTEXTS: [{ id, tokens, pinned }]. */
export function parseWindowRows(text) {
  const { start, end } = windowBlock(text);
  if (start < 0) return [];
  const rows = [];
  for (const line of text.slice(start, end).split("\n")) {
    const m = line.match(ROW_RE);
    if (!m) continue;
    rows.push({ id: m[2], tokens: Number(m[3].replace(/_/g, "")), pinned: /\bpin:/.test(m[4] ?? "") });
  }
  return rows;
}

function isFirstPartyWindow(entry) {
  return !!entry
    && FIRST_PARTY_PROVIDERS.includes(entry.litellm_provider)
    && typeof entry.max_input_tokens === "number";
}

/** The first-party window entry for our model id, or null; `{ ambiguous }`
 *  when two first-party entries disagree. */
export function findSourceWindow(source, id) {
  const keys = [id, ...FIRST_PARTY_PROVIDERS.map((p) => `${p}/${id}`)]
    .filter((k) => Object.prototype.hasOwnProperty.call(source, k) && isFirstPartyWindow(source[k]));
  if (keys.length === 0) return null;
  const first = source[keys[0]];
  for (const k of keys.slice(1)) {
    if (source[k].max_input_tokens !== first.max_input_tokens) return { ambiguous: keys };
  }
  return {
    key: keys[0],
    maxInput: first.max_input_tokens,
    maxOutput: typeof first.max_output_tokens === "number" ? first.max_output_tokens : undefined,
  };
}

/** LiteLLM is inconsistent about whether max_input_tokens is the whole
 *  context window or the window minus the output cap (gpt-5.6: 922,000 =
 *  1,050,000 − 128,000; gpt-5.4: 1,050,000). Either convention matches. */
export function sameWindow(ours, theirs) {
  return ours === theirs.maxInput || (theirs.maxOutput !== undefined && ours === theirs.maxInput + theirs.maxOutput);
}

/**
 * Compare every row against the source. Returns
 *   matched:   [{ id, key }]
 *   drift:     [{ id, key, ours, theirs, proposed }]   rows to fix (or pin)
 *   pinned:    [{ id, key, ours, theirs }]             differ, pinned on purpose
 *   unmatched: [{ id, reason }]
 */
export function compareWindows(rows, source) {
  const matched = [];
  const drift = [];
  const pinned = [];
  const unmatched = [];
  for (const row of rows) {
    const hit = findSourceWindow(source, row.id);
    if (!hit) { unmatched.push({ id: row.id, reason: "no first-party entry" }); continue; }
    if (hit.ambiguous) { unmatched.push({ id: row.id, reason: `first-party entries disagree (${hit.ambiguous.join(", ")})` }); continue; }
    if (sameWindow(row.tokens, hit)) { matched.push({ id: row.id, key: hit.key }); continue; }
    const theirs = hit.maxOutput !== undefined ? `${hit.maxInput} (+${hit.maxOutput} output)` : String(hit.maxInput);
    if (row.pinned) pinned.push({ id: row.id, key: hit.key, ours: row.tokens, theirs });
    else drift.push({ id: row.id, key: hit.key, ours: row.tokens, theirs, proposed: hit.maxInput });
  }
  return { matched, drift, pinned, unmatched };
}

/** 1048576 → "1_048_576", the table's own style. */
export function formatTokens(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

/** Rewrite each drifted row's number in place; the key, indentation and any
 *  trailing comment on the line are kept for the reviewer to judge. */
export function applyWindowDrift(text, drift) {
  const byId = new Map(drift.map((d) => [d.id, d.proposed]));
  const { start, end } = windowBlock(text);
  if (start < 0 || byId.size === 0) return text;
  const block = text.slice(start, end).split("\n").map((line) => {
    const m = line.match(ROW_RE);
    if (!m || !byId.has(m[2])) return line;
    return `${m[1]}"${m[2]}": ${formatTokens(byId.get(m[2]))},${m[4] ?? ""}${m[5]}`;
  });
  return text.slice(0, start) + block.join("\n") + text.slice(end);
}

// Which upstream ids are worth a human's look. Every provider ships dozens of
// dated snapshots, betas and modality variants (tts, image, audio, realtime,
// embeddings) that are not chat models LAX would list; a candidate is a
// current-generation chat id the registry could add as-is.
const openaiCandidate = (id) => /^(gpt-[5-9]|o[3-9])/.test(id)
  && !/-\d{4}-\d{2}-\d{2}$|chat-latest|codex|search|audio|realtime|tts|transcri|image|cyber|^ft:/.test(id);
const CANDIDATE_FILTERS = {
  anthropic: (id) => /^claude-(opus|sonnet|haiku|fable|mythos)-\d/.test(id) && !/-\d{8}$/.test(id),
  openai: openaiCandidate,
  gemini: (id) => /^gemini-\d/.test(id)
    && !/tts|image|embedding|live|audio|computer-use|robotics|customtools|-\d{2}-\d{2}$/.test(id),
  xai: (id) => /^grok-/.test(id) && !/beta|experimental|latest|gv2|image|vision|-\d{4}$/.test(id),
  // LiteLLM's `chatgpt/` rows: what a ChatGPT plan serves (the codex lane).
  chatgpt: openaiCandidate,
};
const FIRST_PARTY_UPSTREAM = ["anthropic", "openai", "gemini", "xai"];

/**
 * Chat models upstream that `known` lacks, per provider — the "sooner than
 * later" nudge to review new releases. By default the first-party providers,
 * against the registry's ids plus the window and price tables' keys; pass
 * `providers: ["chatgpt"]` with one lane's ids to check what a ChatGPT plan
 * serves. Deprecated ids (deprecation_date on or before `today`, ISO date) are
 * skipped. Returns [{ provider, id, maxInput }].
 */
export function upstreamModelsMissing(source, known, { providers = FIRST_PARTY_UPSTREAM, today } = {}) {
  const out = [];
  const seen = new Set();
  for (const [key, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== "object") continue;
    const provider = entry.litellm_provider;
    if (!providers.includes(provider) || !CANDIDATE_FILTERS[provider]) continue;
    if (entry.mode !== "chat" && entry.mode !== "responses") continue;
    if (today && typeof entry.deprecation_date === "string" && entry.deprecation_date <= today) continue;
    const id = key.startsWith(`${provider}/`) ? key.slice(provider.length + 1) : key;
    if (id.includes("/") || known.has(id) || seen.has(id) || !CANDIDATE_FILTERS[provider](id)) continue;
    seen.add(id);
    out.push({ provider, id, maxInput: typeof entry.max_input_tokens === "number" ? entry.max_input_tokens : null });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

/**
 * Split upstreamModelsMissing's result by the reviewed decline list
 * (`{ "<provider>:<id>": "<reason>" }`): `open` still needs a decision,
 * `declined` was looked at and left out on purpose, and `stale` names decline
 * entries for `providers` that no longer match anything, so the list shrinks.
 */
export function partitionDeclined(missing, declined, providers) {
  const open = [];
  const kept = [];
  const hit = new Set();
  for (const m of missing) {
    const key = `${m.provider}:${m.id}`;
    if (Object.prototype.hasOwnProperty.call(declined, key)) { kept.push({ ...m, reason: declined[key] }); hit.add(key); }
    else open.push(m);
  }
  const stale = Object.keys(declined).filter((k) => providers.includes(k.split(":")[0]) && !hit.has(k)).sort();
  return { open, declined: kept, stale };
}

/**
 * Ids LAX lists whose first-party LiteLLM entry carries a deprecation_date on
 * or before `today` (ISO date): the provider has retired them, and the row
 * should go — the registry entry, the window and the price together. Returns
 * [{ id, key, deprecationDate }].
 */
export function upstreamRetired(source, ids, today) {
  const out = [];
  for (const id of new Set(ids)) {
    const key = [id, ...FIRST_PARTY_PROVIDERS.map((p) => `${p}/${id}`)].find((k) => {
      const entry = source[k];
      return !!entry && FIRST_PARTY_PROVIDERS.includes(entry.litellm_provider) && typeof entry.deprecation_date === "string";
    });
    if (key && source[key].deprecation_date <= today) out.push({ id, key, deprecationDate: source[key].deprecation_date });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
