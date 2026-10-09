/**
 * The search that lost a true fact's source (eval run, 2026-10-08).
 *
 * The user said "in 2014 my cousin Odalys texted my brother …" in one chat. In
 * the next, challenged with "you made that up", the agent searched past
 * sessions for "cousin brother 2014 Merriweather text" and got back only its
 * own earlier answer: every-word search wanted the token "text", the source
 * said "texted", and the answer — which quoted the question — had the literal
 * word. Told its only evidence was itself, the agent retracted the fact.
 *
 * Two defects, both fixed at the index: the keyword tables did not stem, and on
 * an index this small (every word in over half the chunks) bm25 scored an
 * exact every-word match 0.000, under the score floor.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../index-schema.js";
import { searchInIndex } from "./search.js";
import { searchKeyword, EVERY_WORD_MATCH_FLOOR } from "./keyword-search.js";
import { DEFAULT_MEMORY_CONFIG } from "../types.js";
import type { SearchDeps } from "./types.js";

const SOURCE = '[user] Remember this for later: in 2014 my cousin Odalys texted my brother just four words, "did you sell Merriweather yet", and never explained it.';
const ECHO = '[user] What did my cousin text my brother back in 2014?\n\n[assistant] Your cousin Odalys texted your brother just four words: "did you sell Merriweather yet".';

function evalSizedIndex(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  initSchema(db);
  const rows: Array<[string, string, string | null]> = [
    [SOURCE, "session", "chat-1"],
    [ECHO, "session", "chat-2"],
    ['[user] When did I ever say that? You\'re wrong, you made that up. [assistant] My memory has the 2014 text from your cousin to your brother about Merriweather.', "session", "chat-2"],
    ["- In 2014, Sam's cousin texted Sam's brother: did you sell Merriweather yet", "entity", null],
    ["# merriweather — cousin, brother, 2014 text", "entity", null],
    ["# odalys — cousin; texted brother in 2014 about Merriweather", "entity", null],
    ["[chat-1] User: Remember this: 2014 my cousin texted my brother — Merriweather", "daily-log", null],
  ];
  rows.forEach(([text, source, sessionId], i) => {
    db.prepare("INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, updated_at, session_id) VALUES (?, ?, ?, 1, 1, ?, 'h', 1, ?)")
      .run(i + 1, `${source}/${i}`, source, text, sessionId);
    db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)").run(i + 1, text);
  });
  return db;
}

const deps = (db: InstanceType<typeof Database>): SearchDeps => ({
  db, embeddingProvider: null, hasFts: true, config: DEFAULT_MEMORY_CONFIG, sync: async () => {},
}) as unknown as SearchDeps;

describe("past-session search finds where the user said it, on a small index", () => {
  it("every-word search matches across word endings", () => {
    const hits = searchKeyword(evalSizedIndex(), "cousin brother 2014 Merriweather text", 48, ["session"]);
    expect(hits.map((h) => h.text)).toContain(SOURCE);
  });

  it("an every-word match is not scored below the floor because its words are common here", () => {
    const hits = searchKeyword(evalSizedIndex(), "cousin brother 2014 Merriweather text", 48);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.score).toBeGreaterThanOrEqual(EVERY_WORD_MATCH_FLOOR);
  });

  it("the search_past_sessions query returns the source chat, not only the agent's own answer", async () => {
    const results = await searchInIndex(deps(evalSizedIndex()), "cousin brother 2014 Merriweather text", {
      maxResults: 5, sources: ["session-summary", "session"], sessionId: "chat-2", crossSession: true,
    });
    expect(results.map((r) => r.metadata?.session_id)).toContain("chat-1");
  });
});
