/**
 * Keyword search finds a memory written in a script whose vowels are combining
 * marks (Hindi, vowelled Arabic, Thai).
 *
 * The query's keywords were split on anything but a letter or digit, which
 * cuts those words at every mark: "हिंदी फ़िल्में" came out as single letters,
 * each under the length floor, so the message had no keywords and searched
 * nothing. Keywords are now whole words (memory/text-utils.ts splitWords), and
 * the index, which is given each one quoted, splits it the way it split the
 * stored text.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { searchKeyword } from "./keyword-search.js";
import { FTS_TOKENIZE } from "../index-schema.js";

function seededDb(texts: string[]): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT NOT NULL,
      embedding TEXT, metadata TEXT, session_id TEXT, updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content=chunks, content_rowid=id, tokenize=${FTS_TOKENIZE});
  `);
  texts.forEach((text, i) => {
    db.prepare("INSERT INTO chunks (id, path, source, start_line, end_line, text, updated_at) VALUES (?, ?, 'entity', 1, 1, ?, 1)")
      .run(i + 1, `bank/${i}.md`, text);
    db.prepare("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)").run(i + 1, text);
  });
  return db;
}

const MEMORIES = [
  "मुझे हिंदी फ़िल्में पसंद हैं",
  "أُحِبُّ القهوة العربية في الصباح",
  "ฉันชอบกาแฟ ร้อน ตอนเช้า",
  "the sourdough starter needs feeding twice a day",
];

describe("keyword search in a script that writes vowels as marks", () => {
  it.each([
    ["Hindi", "हिंदी फ़िल्में", MEMORIES[0]],
    ["vowelled Arabic", "أُحِبُّ القهوة", MEMORIES[1]],
    ["Thai", "ร้อน ตอนเช้า", MEMORIES[2]],
  ])("finds the %s memory by its own words", (_name, query, memory) => {
    expect(searchKeyword(seededDb(MEMORIES), query, 10).map((r) => r.text)).toEqual([memory]);
  });

  it("still requires every word, so a word the memory lacks finds nothing", () => {
    expect(searchKeyword(seededDb(MEMORIES), "हिंदी किताबें", 10)).toEqual([]);
  });
});
