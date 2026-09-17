/**
 * Memory search cost must not grow with the length of the user's message.
 *
 * Live 2026-09-16: every new chat turn runs a memory search over the user's
 * message. A long message (a pasted coding exercise) always misses the
 * every-word query, and the fallback then ran ONE SYNCHRONOUS QUERY PER
 * KEYWORD — duplicates included. On the real 25k-chunk index that was 330
 * queries and 53,104 materialized rows (57% of the index) for one message, and
 * because better-sqlite3 is synchronous the server's event loop froze for
 * 5-8 seconds, starving every other request. The fallback is now ONE any-word
 * query, so the number of FTS statements is fixed whatever the message length.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { searchInIndex } from "./search.js";
import { searchKeyword } from "./keyword-search.js";
import { buildFtsAnyQuery, FTS_ANY_MAX_TERMS } from "../utils.js";
import { DEFAULT_MEMORY_CONFIG } from "../types.js";
import type { SearchDeps } from "./types.js";

function seededDb(): { db: InstanceType<typeof Database>; matches: () => number } {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT NOT NULL,
      embedding TEXT, metadata TEXT, session_id TEXT, updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content=chunks, content_rowid=id);
  `);
  const texts = [
    "the sourdough starter needs feeding twice a day",
    "kelp forests shelter sea otters and urchins",
    "bacteriostatic water reconstitutes the peptide vial",
    "the quarterly invoice for the storage unit is due",
  ];
  texts.forEach((text, i) => {
    db.prepare("INSERT INTO chunks (id, path, source, start_line, end_line, text, updated_at) VALUES (?, ?, 'entity', 1, 1, ?, 1)")
      .run(i + 1, `bank/${i}.md`, text);
    db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)").run(i + 1, text);
  });
  // Count every statement that actually runs a full-text match.
  let count = 0;
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    if (/\bMATCH\b/.test(sql)) count += 1;
    return prepare(sql);
  }) as typeof db.prepare;
  return { db, matches: () => count };
}

function deps(db: InstanceType<typeof Database>): SearchDeps {
  return {
    db,
    embeddingProvider: null,
    hasFts: true,
    config: DEFAULT_MEMORY_CONFIG,
    sync: async () => {},
  } as unknown as SearchDeps;
}

/** A message whose every-word query cannot match: many distinct words, one of
 *  which ("otters") does appear in the index. */
function longMessage(words: number): string {
  const filler = Array.from({ length: words }, (_, i) => `zqword${i}`);
  return ["please explain how otters", ...filler].join(" ");
}

describe("memory search cost is bounded by construction, not by message length", () => {
  it("runs the same number of full-text queries for a 10-word and a 1,000-word message", async () => {
    const short = seededDb();
    await searchInIndex(deps(short.db), longMessage(10), { crossSession: true });
    const long = seededDb();
    await searchInIndex(deps(long.db), longMessage(1_000), { crossSession: true });

    // every-word (misses) + one any-word fallback. Was 1 + one-per-keyword.
    expect(short.matches()).toBe(2);
    expect(long.matches(), "a longer message must not buy more queries").toBe(2);
  });

  it("the any-word fallback still finds the one word that does match", async () => {
    const { db } = seededDb();
    const hits = await searchInIndex(deps(db), longMessage(1_000), { crossSession: true });
    expect(hits.map((h) => h.snippet ?? "").join(" ")).toContain("otters");
  });

  it("ranks a chunk matching more of the words above one matching fewer", () => {
    const { db } = seededDb();
    const ranked = searchKeyword(db, "sea otters kelp invoice", 10, undefined, undefined, "any");
    expect(ranked[0].text).toContain("kelp forests shelter sea otters");
  });

  it("every-word stays the default, so a precise query is not silently broadened", () => {
    const { db } = seededDb();
    expect(searchKeyword(db, "sea otters invoice", 10)).toHaveLength(0);
    expect(searchKeyword(db, "sea otters invoice", 10, undefined, undefined, "any").length).toBeGreaterThan(1);
  });
});

describe("buildFtsAnyQuery", () => {
  it("de-duplicates before capping, so repeats don't spend the budget", () => {
    const q = buildFtsAnyQuery("otter otter otter kelp kelp urchin");
    expect(q).toBe(`"otter" OR "kelp" OR "urchin"`);
  });

  it("caps the term count however long the input is", () => {
    const q = buildFtsAnyQuery(Array.from({ length: 5_000 }, (_, i) => `term${i}`).join(" "));
    expect(q.split(" OR ")).toHaveLength(FTS_ANY_MAX_TERMS);
  });

  it("keeps message order, so the ask that leads the message survives the cap", () => {
    const q = buildFtsAnyQuery(`deploy ${Array.from({ length: 200 }, (_, i) => `pad${i}`).join(" ")}`);
    expect(q.startsWith(`"deploy" OR`)).toBe(true);
  });

  it("returns empty for a message with no keywords", () => {
    expect(buildFtsAnyQuery("the and of")).toBe("");
  });
});
