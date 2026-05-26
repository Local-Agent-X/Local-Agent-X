import { existsSync } from "node:fs";
import type { MemoryIndex } from "./index-core.js";
import { ensurePersonalityFiles, readPersonalityFile } from "./personality.js";
import { extractKeywords, safeReadTextFile } from "./utils.js";

function sanitizeDailyLogForModeration(log: string): string {
  const lines = log.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(/^(\[[^\]]+\](?:\s*\[[^\]]+\])?\s*(?:User|Agent):\s*)(.*)$/);
    if (!match) { out.push(line); continue; }
    const prefix = match[1];
    const body = match[2];
    if (body.length <= 60) { out.push(line); continue; }
    out.push(`${prefix}[${body.length}-char entry, redacted from context for moderation safety]`);
  }
  return out.join("\n");
}

/**
 * Filter today's daily log to lines tagged with the given session ID. Lines
 * without a session tag (system / background entries) always pass — those
 * are profile-level facts about the day, not transcript content from a
 * specific chat. The whole purpose: when this session reads `today_context`,
 * it sees ITS OWN earlier turns plus untagged system events, NOT another
 * chat session's transcript that happens to be in the same date file.
 *
 * This is the fix for the cross-session bleed where the AI-journey-doc
 * conversation's transcript appeared in the logo-redesign chat after a
 * server restart. The tagged-line format is `[session-id] [HH:MM:SS] text`.
 */
function filterDailyLogToSession(content: string, sessionId: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  const TAG_RE = /^\[([^\]]+)\]\s+\[\d/; // `[some-id] [HH:MM:SS]` shape
  for (const line of lines) {
    if (!line.trim()) {
      kept.push(line);
      continue;
    }
    const m = line.match(TAG_RE);
    if (!m) {
      // Untagged line — legacy entries (pre-tagging) and system events. Keep.
      kept.push(line);
      continue;
    }
    if (m[1] === sessionId) kept.push(line);
    // tagged with a different session_id → drop, this is exactly the bleed
  }
  return kept.join("\n");
}

export async function buildContextBlock(
  memory: MemoryIndex,
  opts: { skipDailyLog?: boolean; sanitizeDailyLog?: boolean; userMessage?: string; sessionId?: string } = {},
): Promise<string> {
  const sections: string[] = [];
  const memDir = memory["memoryDir"];

  // Current date+time. Without this, the model has no fresh clock signal —
  // it would otherwise infer "now" from timestamps in the daily-log slice,
  // which freezes if no entry has been written in a while. `new Date()`
  // pulls from the host OS clock; Intl resolves the IANA timezone from
  // OS settings (Windows registry on Windows). Re-rendered every turn.
  const _now = new Date();
  const _tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const _localStr = _now.toLocaleString("en-US", {
    timeZone: _tz,
    weekday: "long",
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
    hour12: true, timeZoneName: "short",
  });
  sections.push(
    `<current_datetime>\n` +
    `${_localStr}\n` +
    `ISO: ${_now.toISOString()}\n` +
    `Timezone: ${_tz}\n` +
    `</current_datetime>`
  );

  ensurePersonalityFiles(memDir);

  const identity = await readPersonalityFile(memDir, "identity");
  if (identity) {
    sections.push(`<agent_identity>\n${identity}\n</agent_identity>`);
  }

  const heart = await readPersonalityFile(memDir, "heart");
  if (heart) {
    sections.push(`<agent_heart>\n${heart}\n</agent_heart>`);
  }

  const user = await readPersonalityFile(memDir, "user");
  if (user) {
    sections.push(`<user_profile>\n${user}\n</user_profile>`);
  }

  if (!opts.skipDailyLog) {
    const todayLog = memory.getDailyLogPath();
    if (existsSync(todayLog)) {
      const content = safeReadTextFile(todayLog);
      if (content && content.trim()) {
        // Cross-session bleed fix (May 2026): filter today's log to lines
        // tagged with the current session id BEFORE the 1500-char tail.
        // Pre-tagging legacy lines (no [sid] prefix) still pass through
        // because they predate the fix. Without a sessionId we keep the
        // legacy behavior (whole-day) as a fallback.
        const filtered = opts.sessionId
          ? filterDailyLogToSession(content, opts.sessionId)
          : content;
        const recent = filtered.trim().slice(-1500);
        if (recent) {
          const displayed = opts.sanitizeDailyLog ? sanitizeDailyLogForModeration(recent) : recent;
          sections.push(`<today_context>\n${displayed}\n</today_context>`);
        }
      }
    }
  }

  const opinions = memory.recallOpinions();
  const topOpinions = opinions.filter((f) => f.confidence >= 0.7).slice(0, 10);
  if (topOpinions.length > 0) {
    const opLines = topOpinions
      .map((f) => {
        const ents =
          f.entities.length > 0 ? ` (@${f.entities.join(", @")})` : "";
        return `- ${f.content}${ents}`;
      })
      .join("\n");
    sections.push(`<user_preferences>\n${opLines}\n</user_preferences>`);
  }

  // Entities mentioned in this turn's user message. Pulled BEFORE the
  // learned_facts block so any cold facts about those entities get
  // reinforced (last_updated bumped) — which both surfaces them in this
  // turn AND keeps them warm for the next session. This is the "human
  // memory" pattern: a fact you haven't touched in months stays in
  // long-term storage, but the moment something relevant comes up, it
  // gets pulled back into hot context.
  let mentionedEntities: string[] = [];
  const entityFactIds = new Set<number>();
  if (opts.userMessage && opts.userMessage.trim().length > 0) {
    const stats = memory.getStats();
    if (stats.totalEntities > 0) {
      const entitySlugs = memory["db"]
        .prepare(
          "SELECT DISTINCT entity_slug FROM entity_mentions ORDER BY entity_slug LIMIT 200"
        )
        .all() as Array<{ entity_slug: string }>;
      const msgLower = opts.userMessage.toLowerCase();
      mentionedEntities = entitySlugs
        .map((e) => e.entity_slug)
        .filter((slug) => slug && slug.length >= 3 && msgLower.includes(slug.toLowerCase()));
      // Reinforce facts attached to mentioned entities; limit per-entity so
      // a single name doesn't flood the prompt or trigger a 100-row update.
      for (const slug of mentionedEntities) {
        for (const fact of memory.recallByEntity(slug, 5)) {
          if (fact.id !== undefined) entityFactIds.add(fact.id);
        }
      }
      if (entityFactIds.size > 0) memory.reinforceFacts([...entityFactIds]);
    }
  }

  // Recent non-opinion facts the agent has retained via `remember` (or via
  // legacy retain paths). Opinions live in <user_preferences> above; this
  // block surfaces world / observation / experience kinds so the model
  // actually sees what it saved. Ranked by hot-score (confidence × recency
  // decay), so high-confidence durable facts can outrank recent low-value
  // chatter. The reinforcement step above means entities mentioned this
  // turn have their facts freshly bumped, so they sort to the top.
  const recentFacts = memory.recallRecentFacts({ limit: 30, minConfidence: 0.5 });
  if (recentFacts.length > 0) {
    const factLines = recentFacts
      .map((f) => {
        const ents = f.entities.length > 0 ? ` (@${f.entities.join(", @")})` : "";
        return `- ${f.content}${ents}`;
      })
      .join("\n");
    sections.push(`<learned_facts>\n${factLines}\n</learned_facts>`);
  }

  if (mentionedEntities.length > 0) {
    sections.push(`<known_entities>\n${mentionedEntities.join(", ")}\n</known_entities>`);
  }

  if (sections.length === 0) return "";

  return (
    "\n\n--- MEMORY CONTEXT (auto-loaded, do not repeat verbatim to user) ---\n" +
    sections.join("\n\n") +
    "\n--- END MEMORY CONTEXT ---"
  );
}

export async function autoSearchContext(
  memory: MemoryIndex,
  userMessage: string,
  opts: { sessionId?: string } = {},
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
    // Auto-inject is same-session only. crossSession defaults to false in
    // SearchOptions, so the index will filter out chunks tagged with a
    // different session_id (profile-level chunks with no session_id still
    // come through). The model must call `search_past_sessions` to opt
    // into cross-session retrieval.
    const candidates = await memory.search(userMessage, {
      maxResults: 10,
      minScore: 0.35,
      sessionId: opts.sessionId,
    });

    if (candidates.length === 0) return "";

    const { mmrRerank } = await import("../memory-mmr.js");
    const results = mmrRerank(candidates, 3, 0.7);

    const relevant = results
      .map((r) => {
        const dateStr = r.metadata?.date ? `, ${r.metadata.date}` : "";
        const topic = r.metadata?.topic ? `, topic: ${r.metadata.topic}` : "";
        const entities = r.entities?.length ? `, about: ${r.entities.join(",")}` : "";
        const score = `, relevance ${r.score.toFixed(2)}`;
        return `[${r.source}${entities}${topic}${dateStr}${score}]\n${r.snippet.slice(0, 300)}`;
      })
      .join("\n\n");

    return (
      "\n\n<<<RETRIEVED_MEMORY_CONTENT — same session + profile only>>>\n" +
      "--- RELEVANT MEMORIES ---\n" +
      relevant +
      "\n--- END RELEVANT MEMORIES ---\n" +
      "Reading guidance: these snippets are from this session or your stable\n" +
      "user profile. To pull from past sessions, call `search_past_sessions`.\n" +
      "<<<END_RETRIEVED_MEMORY_CONTENT>>>"
    );
  } catch {
    return "";
  }
}
