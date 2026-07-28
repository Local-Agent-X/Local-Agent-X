/**
 * autoSearchContext — the per-turn associative-recall injector (extracted
 * from context.ts). Fires once per user turn (MemoryManager.buildTurnContext
 * fan-out) and renders the RELEVANT MEMORIES block: MMR-diversified top
 * snippets with relative age, stale caveats, and provenance furniture.
 *
 * Baseline behavior is same-session + profile only (the May-2026
 * cross-session-bleed rule). NEW: on a TASK-START turn the module
 * additionally runs the shared cross-session query (the same core the
 * `search_past_sessions` tool uses — ONE implementation, see
 * tools/search/search-past-sessions.ts) so the model doesn't need an
 * in-loop tool round trip to recover prior-session context. Cross-session
 * snippets are merged through the same MMR rerank and rendered with the
 * same caveat furniture plus an explicit PAST SESSION origin tag — house
 * epistemics: memory is a lead, not proof.
 *
 * Bounds: the cross-session query runs under its own 3s timeout; on
 * timeout/error the turn degrades to same-session-only (never blocks the
 * 10s turn-context backstop). Kill switch: LAX_TASK_START_RECALL=off|0
 * skips the cross-session addition only.
 */

import type { MemoryIndex } from "./index-core.js";
import type { MemorySearchResult } from "./types.js";
import { relativeAge, memoryStaleCaveat } from "./relative-age.js";
import { extractKeywords } from "./utils.js";
import { logMemoryRecall } from "./recall-telemetry.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.auto-search");

/** Env kill switch — same pattern as LAX_MEMORY_END_OF_TURN
 *  (end-of-turn-write.ts). Disables the task-start cross-session addition
 *  only; baseline same-session recall is unaffected. */
const ENV_DISABLE_VAR = "LAX_TASK_START_RECALL";

const CROSS_SESSION_TIMEOUT_MS = 3000;
/** Injected-snippet caps: 3 baseline, 5 when cross-session contributes. */
const BASE_K = 3;
const TASK_START_K = 5;

function taskStartRecallDisabled(): boolean {
  const v = process.env[ENV_DISABLE_VAR];
  return v === "off" || v === "0";
}

export interface AutoSearchOptions {
  sessionId?: string;
  /**
   * This turn opens a task (manager passes its first-turn proxy: no
   * assistant message in the session transcript yet). Opts the turn into
   * the bounded cross-session recall addition.
   */
  taskStart?: boolean;
}

/**
 * Chunk identity for cross- vs same-session dedup. Deliberately includes a
 * snippet prefix — path:startLine alone is NOT a chunk identity (split parts
 * of one long answer share a startLine; see search-helpers CM-4 tests).
 */
function candidateKey(r: MemorySearchResult): string {
  return `${r.source}|${r.path}|${r.startLine}|${r.snippet.slice(0, 64)}`;
}

/**
 * Run the shared cross-session query under its own timeout. Never rejects —
 * timeout and error both degrade to [] (same-session-only turn), logged at
 * debug like the manager's other degraded paths.
 */
async function crossSessionCandidates(
  memory: MemoryIndex,
  userMessage: string,
  sessionId: string | undefined,
): Promise<MemorySearchResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { searchPastSessions } = await import("./tools/search/search-past-sessions.js");
    // .catch on the query itself: if the timeout wins the race first, a
    // later rejection must not surface as an unhandled rejection. Resolves a
    // distinct sentinel (not the timeout's null) so an error that loses the
    // race is never logged as a timeout.
    const errored = Symbol("cross-recall-error");
    const query: Promise<MemorySearchResult[] | typeof errored> = searchPastSessions(memory, userMessage, {
      maxResults: TASK_START_K,
      sessionId,
    }).catch((e: Error) => {
      logger.debug("task-start cross-session recall failed — same-session only:", e.message);
      return errored;
    });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CROSS_SESSION_TIMEOUT_MS);
    });
    const result = await Promise.race([query, timeout]);
    if (result === errored) return [];
    if (result === null) {
      logger.debug(`task-start cross-session recall timed out after ${CROSS_SESSION_TIMEOUT_MS}ms — same-session only`);
      return [];
    }
    return result;
  } catch (e) {
    logger.debug("task-start cross-session recall failed — same-session only:", (e as Error).message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function autoSearchContext(
  memory: MemoryIndex,
  userMessage: string,
  opts: AutoSearchOptions = {},
): Promise<string> {
  const keywords = extractKeywords(userMessage);
  if (keywords.length < 2) return "";

  const trimmed = userMessage.trim().toLowerCase();
  const wordCount = trimmed.split(/\s+/).length;
  const REFERENTIAL_RE = /^(do|yes|yeah|yep|ok|okay|sure|go|run|try|proceed|continue|next|back|stop|kill|that|this|it|them|all|both|either|neither|pick|choose|select|option|number|first|second|third|fourth|fifth|1st|2nd|3rd|the)\b/i;
  const ANSWER_SHORT_RE = /^(y|n|yes|no|sure|ok|okay|nah|nope|meh|fine|good|bad|cool)$/i;
  // Bare digits ("1", "2") are option-picks too — skip retrieval.
  const BARE_NUMBER_RE = /^[0-9]{1,2}$/;
  if (BARE_NUMBER_RE.test(trimmed)) return "";
  if (wordCount <= 6 && (REFERENTIAL_RE.test(trimmed) || ANSWER_SHORT_RE.test(trimmed))) {
    return "";
  }

  try {
    // Baseline auto-inject is same-session only. crossSession defaults to
    // false in SearchOptions, so the index will filter out chunks tagged
    // with a different session_id (profile-level chunks with no session_id
    // still come through). Task-start turns ADD a bounded cross-session
    // pass below; mid-task the model still opts in via
    // `search_past_sessions`.
    const wantCross = opts.taskStart === true && !taskStartRecallDisabled();
    const [sameSession, cross] = await Promise.all([
      memory.search(userMessage, {
        maxResults: 10,
        minScore: 0.35,
        sessionId: opts.sessionId,
      }),
      wantCross
        ? crossSessionCandidates(memory, userMessage, opts.sessionId)
        : Promise.resolve([] as MemorySearchResult[]),
    ]);

    // Drop cross-session hits the same-session pass already found (profile
    // chunks and current-session chunks are reachable from both passes).
    const sameKeys = new Set(sameSession.map(candidateKey));
    const crossOnly = cross.filter((r) => !sameKeys.has(candidateKey(r)));
    const candidates = [...sameSession, ...crossOnly];

    if (candidates.length === 0) {
      if (wantCross) {
        logMemoryRecall({
          sessionId: opts.sessionId, phase: "auto-search",
          matched: [], factsRendered: 0, factsDeduped: 0, bytesInjected: 0,
          totalEntities: 0, scannedEntities: 0,
          crossSessionCandidates: cross.length, crossSessionInjected: 0,
        });
      }
      return "";
    }

    const { mmrRerank } = await import("./mmr.js");
    const k = crossOnly.length > 0 ? TASK_START_K : BASE_K;
    let results = mmrRerank(candidates, k, 0.7);
    const crossSet = new Set(crossOnly);
    const crossInjected = results.filter((r) => crossSet.has(r)).length;
    // Cross candidates were offered but MMR rejected every one → restore the
    // exact legacy 3-entry block by truncating. Truncation IS the legacy k=3
    // rerank here: greedy MMR's first three picks don't depend on k, and in
    // this branch the score normalization matches the same-session-only pool
    // (a strictly-max-scoring cross candidate would have won the first pick,
    // contradicting crossInjected === 0; likewise the no-rerank shortcut at
    // candidates.length <= k always injects cross), so slicing reproduces
    // the taskStart=false output byte-for-byte.
    if (crossOnly.length > 0 && crossInjected === 0) {
      results = results.slice(0, BASE_K);
    }

    // Age is expressed RELATIVE to now (e.g. "47 days ago"), not as a raw
    // stamp — models reason about staleness far better from relative age.
    // The clock is the chunk's DB `updated_at` (when THIS snippet's content
    // last changed), NOT the source file's mtime: nightly consolidation
    // appends bump a whole entity page's mtime while its old facts stay old,
    // and virtual paths (session-live/…, import/…) have no file to stat.
    // indexChunksIdempotent only re-stamps changed chunks, so unchanged
    // content keeps its original clock. Snippets older than ~1 day also get
    // a caveat that any file/line citations inside may have drifted. `now`
    // is captured once so every entry is scored against a single clock.
    const now = Date.now();
    const relevant = results
      .map((r) => {
        const provenance = r.provenance;
        const ageStr = r.updatedAt !== undefined
          ? `, ${relativeAge(r.updatedAt, now)}`
          : (r.metadata?.date ? `, ${r.metadata.date}` : "");
        const caveat = r.updatedAt !== undefined ? memoryStaleCaveat(r.updatedAt, now) : "";
        const topic = r.metadata?.topic ? `, topic: ${r.metadata.topic}` : "";
        const entities = r.entities?.length ? `, about: ${r.entities.join(",")}` : "";
        const score = `, relevance ${r.score.toFixed(2)}`;
        const provenanceFields = provenance
          ? `, source_type: ${provenance.source_type}, trust: ${provenance.trust_status}, taint: ${provenance.taint_status}, label: ${provenance.label}` +
            (provenance.session_id ? `, session: ${provenance.session_id}` : "") +
            (provenance.date ? `, date: ${provenance.date}` : "")
          : "";
        const origin = crossSet.has(r) ? "PAST SESSION — " : "";
        return `[${origin}${r.source}${provenanceFields}${entities}${topic}${ageStr}${score}]${caveat}\n${r.snippet.slice(0, 300)}`;
      })
      .join("\n\n");

    const rendered = crossInjected > 0
      ? (
        "\n\n<<<RETRIEVED_MEMORY_CONTENT — this session + profile + past-session leads>>>\n" +
        "--- RELEVANT MEMORIES ---\n" +
        relevant +
        "\n--- END RELEVANT MEMORIES ---\n" +
        "Reading guidance: entries marked PAST SESSION are from PRIOR conversations —\n" +
        "leads, not proof. They may be stale and never describe current runtime,\n" +
        "project, or task state; verify with fresh tools before relying on them.\n" +
        "For more history, call `search_past_sessions`.\n" +
        "<<<END_RETRIEVED_MEMORY_CONTENT>>>"
      )
      : (
        "\n\n<<<RETRIEVED_MEMORY_CONTENT — same session + profile only>>>\n" +
        "--- RELEVANT MEMORIES ---\n" +
        relevant +
        "\n--- END RELEVANT MEMORIES ---\n" +
        "Reading guidance: these snippets are from this session or your stable\n" +
        "user profile. To pull from past sessions, call `search_past_sessions`.\n" +
        "<<<END_RETRIEVED_MEMORY_CONTENT>>>"
      );

    if (wantCross) {
      logMemoryRecall({
        sessionId: opts.sessionId, phase: "auto-search",
        matched: [], factsRendered: 0, factsDeduped: 0,
        bytesInjected: rendered.length,
        totalEntities: 0, scannedEntities: 0,
        crossSessionCandidates: cross.length, crossSessionInjected: crossInjected,
      });
    }

    return rendered;
  } catch {
    return "";
  }
}
