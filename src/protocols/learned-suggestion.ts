import crossSessionLearner from "../cognition/cross-session-learning/index.js";
import type { LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import { getAllProtocols } from "./index.js";
import { loadLearnedProtocol, type LearnedProtocolRecord } from "./learned-lifecycle.js";
import type { Protocol } from "./types.js";

/**
 * Precision model (F18). Admission and ranking answer different questions and
 * must not share an instrument.
 *
 * ADMISSION — "is this request about this protocol?" — is computed only from
 * quantities that do not depend on what else is in the catalog: the share of
 * the user's distinctive terms the protocol accounts for, after the
 * corpus-independent STOP_TERMS/GENERIC_TERMS filters. Nothing here changes
 * when another protocol is authored.
 *
 * RANKING — "which of the admitted protocols?" — is IDF-weighted, because
 * rarity is exactly the right signal for choosing between candidates.
 *
 * An earlier revision used IDF for admission too, and it was self-defeating:
 * IDF measures "rare in this corpus", so every protocol the authoring fork
 * wrote about a topic lowered the weight of that topic's words and made the
 * NEXT request about it less likely to retrieve anything. Measured: a bare
 * "purchase order" scored 2.00 with one purchase-order protocol installed,
 * 1.61 with two, 0.94 with six — falling through a 1.9 floor at the first
 * topical neighbour and never recovering. That inverts the campaign, and it
 * inverts it hardest on the workflows the user repeats most, which are the only
 * ones the fork ever writes about. Topic density is evidence that the user
 * works in that topic; it must raise retrieval, not end it.
 *
 * MIN_COVERAGE is length-normalized and df-free, so it is stable under catalog
 * growth. Its job is to reject ASIDES — a request that mentions a protocol's
 * subject in passing gives it, by definition, a small share of the message. It
 * does NOT try to reject plausible-but-uncertain matches: the notice asks the
 * model to load a protocol before acting and the model can disregard it, so a
 * merely plausible suggestion costs far less than silence on the user's most
 * repeated workflow. The labelled corpus this threshold is derived from lives
 * in learned-suggestion.test.ts as data, and a test re-derives the separation.
 */
const MIN_COVERAGE = 0.35;
/**
 * A verbatim trigger/description hit is a RANKING bonus only. It used to
 * short-circuit the gate, which let a protocol carrying the short triggers and
 * tags that agent-authored records get by construction beat genuine matches at
 * 12% coverage.
 */
const EXACT_PHRASE_BONUS = 3;
/**
 * Names that may be interpolated into the first-party harness notice.
 *
 * There is NO name validation anywhere on the protocol write path (F23) and
 * names are now agent-authored, so the name is untrusted input on a channel the
 * model reads as instructions. What this enforces, exactly: lowercase slug
 * shape, no whitespace, no sentence punctuation, ≤48 characters. So the name
 * cannot close the notice (`[`/`]`), cannot escape the tool-argument literal
 * (`"`/`\`), cannot introduce a line break, cannot form a sentence, and cannot
 * SHOUT. A name outside the shape is not suggested at all — rendering an
 * escaped or mangled name would point the model at a protocol that does not
 * exist, so failing closed is the only correct option.
 *
 * What this does NOT claim to stop: an underscore-joined imperative
 * (`ignore_the_note_above`) is still expressible in 48 lowercase characters.
 * The residual is accepted because the CARRIER is small and bounded — 48
 * lowercase characters with no whitespace, rendered quoted, inside a
 * harness-composed sentence — not because it matches the risk already accepted
 * for protocol BODIES. It does not: a body is read only after the model chooses
 * to call `protocol(action:"get")` and arrives framed as retrieved content,
 * whereas this name is pushed into the system prompt unfenced on every turn,
 * before any tool call and without the model electing to see it. Different
 * channel, timing, and consent; same disposition, different reasoning.
 */
const SUGGESTIBLE_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/**
 * Slug shape owned by the managed learned tier (`learnedProtocolSlug`).
 * A `custom`-typed record carrying this shape shadows the learned record of the
 * same name (custom wins `mergeByName`), so it never reaches the widened path.
 *
 * Scope of this guard, precisely — it covers ONLY records the loader stamps
 * `custom`, i.e. records whose `source` was absent on disk. It does NOT cover a
 * hand-edited custom.json record that self-declares `source:{type:"imported"}`:
 * `stampCustomSource` (loader.ts:234-236) stamps only when `source` is absent,
 * so a self-declared type survives, wins `mergeByName`, and reaches
 * `verifiedActiveProtocol` looking like a managed learned record.
 *
 * That hole is PRE-EXISTING and not closed here. It is not agent- or
 * HTTP-reachable today (no write path lets a caller set `source.type`), but
 * custom.json is git-synced and hand-editable. Closing it properly means
 * resolving the record's provenance against `learnedProtocolsDir()` — the check
 * `protocol(action:"get")` already makes at index.ts:180-188 — which adds a
 * per-turn disk read on the hot path and belongs with the write-path name/source
 * validation follow-up (F23), not in this chunk.
 */
const LEARNED_SLUG = /^learned-[a-f0-9]{20}$/;
const GENERIC_TERMS = new Set([
  "active", "agent", "automatic", "coding", "handle", "learned", "process",
  "protocol", "request", "task", "use", "using", "workflow",
]);
const STOP_TERMS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "by", "can", "do",
  "for", "from", "how", "i", "in", "into", "is", "it", "me", "my", "of",
  "on", "or", "our", "please", "that", "the", "then", "this", "to", "we",
  "what", "when", "with", "you", "your",
]);

export interface LearnedProtocolSuggestion {
  name: string;
  score: number;
  nudge: string;
}

type RecordLoader = (slug: string) => LearnedProtocolRecord;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function distinctiveTerms(value: string): Set<string> {
  return new Set(normalize(value).split(" ").filter((term) =>
    term.length >= 3 && !STOP_TERMS.has(term) && !GENERIC_TERMS.has(term),
  ));
}

/** Matchable text of a protocol. Defensive on the widened path: the custom
 *  tier is raw JSON off disk, so a hand-edited or half-synced record can be
 *  missing either array. */
function protocolFields(protocol: Protocol): string[] {
  return [
    protocol.description ?? "",
    ...(protocol.triggers ?? []),
    ...(protocol.tags ?? []),
  ];
}

function protocolTermsOf(protocol: Protocol): Set<string> {
  return new Set(protocolFields(protocol).flatMap((field) => [...distinctiveTerms(field)]));
}

interface TermWeights {
  /** Inverse document frequency across the catalog. Unseen terms are treated
   *  as singletons rather than as maximally rare, so a message full of words
   *  the catalog has never heard of does not become impossible to cover. */
  weight: (term: string) => number;
  /** Weight of a term that appears in exactly one protocol — the unit the
   *  ranking score is denominated in. */
  singleton: number;
  /** Term set per protocol, memoized while building the table. Tokenizing is
   *  the dominant per-turn cost and every protocol is otherwise tokenized
   *  twice — once to count document frequency, once to match. */
  termsOf: (protocol: Protocol) => Set<string>;
}

/** Build the IDF table over the WHOLE catalog, including tiers that are never
 *  suggested. Distinctiveness is a property of the corpus: `post` is a junk
 *  term precisely because several built-ins use it, and that stays true whether
 *  or not built-ins are suggestible.
 *
 *  Rebuilt every turn: measured ~0.25ms of scoring for the shipped 26-protocol
 *  catalog, ~0.94ms at 125, ~3.3ms at 499 (±10% run to run). Memoizing the term
 *  sets here — rather than tokenizing every protocol twice, once to count
 *  document frequency and once to match — is worth ~22% of the 499-protocol
 *  turn (5.1ms -> 4.0ms, a factor of 1.3). A real saving, not a halving.
 *
 *  The table itself is NOT cached across turns. A sound key does exist —
 *  `saveCustomProtocols` is the documented single write choke point for the
 *  only tier that changes at runtime, so a version counter bumped there, or a
 *  content hash over name+description+triggers+tags, would invalidate
 *  correctly; keying on `protocols.length` is what would reproduce F1. Not
 *  spending that complexity at present catalog sizes; revisit if the custom
 *  tier grows past a few hundred. */
function buildTermWeights(protocols: Protocol[]): TermWeights {
  const documentFrequency = new Map<string, number>();
  const termsByProtocol = new Map<Protocol, Set<string>>();
  for (const protocol of protocols) {
    const terms = protocolTermsOf(protocol);
    termsByProtocol.set(protocol, terms);
    for (const term of terms) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  // Guard against division by a degenerate corpus, not a tuning knob: an
  // earlier floor of 20 was removed because nothing observable depended on it.
  const corpus = Math.max(protocols.length, 1);
  const idf = (frequency: number): number => Math.log(1 + (corpus - frequency + 0.5) / (frequency + 0.5));
  return {
    weight: (term) => idf(Math.max(documentFrequency.get(term) ?? 0, 1)),
    singleton: idf(1),
    termsOf: (protocol) => termsByProtocol.get(protocol) ?? protocolTermsOf(protocol),
  };
}

function totalWeight(terms: Iterable<string>, weights: TermWeights): number {
  let sum = 0;
  for (const term of terms) sum += weights.weight(term);
  return sum;
}

/**
 * How much of the protocol's own NAME the request spells out. Used ONLY to
 * break score ties, and measured in absolute terms on purpose.
 *
 * Plain alphabetical ordering systematically favoured whichever name sorted
 * first — with `thriveventory_purchase_order` and `po_receiving` installed,
 * "purchase order" resolved to `po_receiving` because `p` < `t`. The first fix
 * for that normalized hits by the candidate's own name length, which merely
 * MOVED the bias: `order` scored 1.0 on any request containing "order" and
 * nothing longer could beat it, and `purchase_order` tied the target's 3-of-3
 * even on a request that said "thriveventory".
 *
 * Two absolute keys instead, `hits` then `misses`:
 *   hits   — how many of the name's terms the request actually says. A request
 *            naming the user's system out-hits a generic name.
 *   misses — how many are left over. Resists name-stuffing: padding a name adds
 *            terms an ordinary request will not say, so it loses on misses. It
 *            can never gain, because padding cannot raise hits.
 * Neither is normalized, so a short name has no structural advantage.
 */
interface NameMatch { hits: number; misses: number; }

function nameMatch(protocol: Protocol, messageTerms: Set<string>): NameMatch {
  const nameTerms = distinctiveTerms(protocol.name);
  let hits = 0;
  for (const term of nameTerms) if (messageTerms.has(term)) hits += 1;
  return { hits, misses: nameTerms.size - hits };
}

interface ProtocolMatch {
  /** IDF-weighted, for ranking. Never consulted for admission. */
  score: number;
  name: NameMatch;
}

function evaluateProtocol(
  message: string,
  messageTerms: Set<string>,
  protocol: Protocol,
  weights: TermWeights,
): ProtocolMatch | null {
  const matched = [...weights.termsOf(protocol)].filter((term) => messageTerms.has(term));
  if (matched.length < 2) return null;

  // ── ADMISSION: corpus-independent, so authoring more protocols about a
  //    topic can never make that topic harder to retrieve. ──
  if (matched.length / messageTerms.size < MIN_COVERAGE) return null;

  // ── RANKING: corpus-sensitive on purpose. ──
  const normalizedMessage = ` ${normalize(message)} `;
  const exactPhrase = protocolFields(protocol).some((field) => {
    const phrase = normalize(field);
    return distinctiveTerms(field).size >= 2 && phrase.length > 0 && normalizedMessage.includes(` ${phrase} `);
  });
  const score = (totalWeight(matched, weights) / weights.singleton) * 10
    + (exactPhrase ? EXACT_PHRASE_BONUS : 0);
  return { score, name: nameMatch(protocol, messageTerms) };
}

function verifiedActiveProtocol(
  candidate: LearnedCandidate,
  protocols: Protocol[],
  loadRecord: RecordLoader,
): Protocol | null {
  if (candidate.state !== "active") return null;
  const record = loadRecord(candidate.id);
  if (record.state !== "active" || !record.activeVersionId || record.slug !== candidate.id) return null;
  const activeVersion = record.versions.find((version) => version.id === record.activeVersionId);
  if (!activeVersion || activeVersion.metadata.candidateId !== candidate.id) return null;
  const protocol = protocols.find((entry) => entry.name === record.slug);
  if (!protocol || protocol.source?.type !== "imported") return null;
  return protocol;
}

/**
 * Two tiers are scored, and the tier boundary is load-bearing:
 *
 * 1. MANAGED LEARNED (`source.type === "imported"` + a verified learned
 *    record). Reached only through `verifiedActiveProtocol`, whose integrity
 *    checks stay exactly as they were — a draft, archived, orphaned, or
 *    tampered learned record must never be suggested.
 * 2. CUSTOM (`source.type === "custom"`). This is where agent-authored
 *    protocols live and can only live: provenance stamping is structurally
 *    impossible for the bundled/imported/learned tiers (F14), so the
 *    background review fork writes custom.json. Before this, `custom` records
 *    could never be suggested at all and the write half was unreachable.
 *
 * Deliberately NOT scored: builtin and bundled. They are already reachable by
 * trigger match and `protocol(action:"search")`, they carry the longest
 * descriptions in the catalog (and so produced every measured false positive),
 * and the `imported` tier cannot be opened wholesale without letting an
 * unverified learned record in through the side door.
 */
export function selectLearnedProtocolSuggestion(
  message: string,
  candidates: LearnedCandidate[],
  protocols: Protocol[],
  loadRecord: RecordLoader,
): LearnedProtocolSuggestion | null {
  const messageTerms = distinctiveTerms(message);
  if (messageTerms.size < 2) return null;
  const weights = buildTermWeights(protocols);
  // `tier` breaks TIES ONLY, and the guarantee is exactly that: on an equal
  // score the verified learned record wins. It is NOT "verified beats
  // unverified" — a higher-scoring custom record does displace a verified
  // learned one, which is intended, since score reflects how well the request
  // matches.
  const ranked: Array<{ protocol: Protocol; score: number; name: NameMatch; tier: number }> = [];
  const consider = (protocol: Protocol, tier: number): void => {
    if (!SUGGESTIBLE_NAME.test(protocol.name)) return;
    const match = evaluateProtocol(message, messageTerms, protocol, weights);
    if (match) ranked.push({ protocol, score: match.score, name: match.name, tier });
  };
  for (const candidate of candidates) {
    try {
      const protocol = verifiedActiveProtocol(candidate, protocols, loadRecord);
      if (protocol) consider(protocol, 0);
    } catch {
      // A missing, malformed, or tampered learned record is never suggested.
    }
  }
  for (const protocol of protocols) {
    if (protocol.source?.type !== "custom") continue;
    if (LEARNED_SLUG.test(protocol.name)) continue;
    consider(protocol, 1);
  }
  // A tie is a RANKING problem, not a reason to say nothing. Suppressing on a
  // tie meant the more protocols the authoring fork wrote, the less retrieval
  // worked — near-duplicates (`po_intake` / `po_intake_v2`) silenced each other
  // permanently, and any custom record could silence a verified learned one.
  // Resolve deterministically instead: score, tier, name hits, name misses,
  // then alphabetical. The two name keys sit ahead of the alphabetical
  // fallback so a tie does not systematically go to whichever name sorts
  // first, and they are absolute rather than normalized so it does not go to
  // whichever name is shortest either.
  ranked.sort((a, b) =>
    b.score - a.score
    || a.tier - b.tier
    || b.name.hits - a.name.hits
    || a.name.misses - b.name.misses
    || a.protocol.name.localeCompare(b.protocol.name));
  const best = ranked[0];
  if (!best) return null;
  const name = best.protocol.name;
  return {
    name,
    score: best.score,
    nudge: `"${name}" is a stored protocol matching this request. Load it with protocol(action:"get", params:{name:"${name}"}) before acting, then follow it.`,
  };
}

export function getLearnedProtocolSuggestion(message: string): LearnedProtocolSuggestion | null {
  try {
    return selectLearnedProtocolSuggestion(
      message,
      crossSessionLearner.getCandidates(),
      getAllProtocols(),
      loadLearnedProtocol,
    );
  } catch {
    return null;
  }
}
