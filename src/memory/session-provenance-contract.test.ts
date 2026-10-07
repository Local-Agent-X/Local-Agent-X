import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildSessionChunks } from "./chunking.js";
import { toSearchResult } from "./search-helpers.js";
import type { Chunk } from "./types.js";

// Locks on the class behind the 2026-10-05 and 2026-10-07 flip-flops: an
// agent that cannot stand behind true claims because its evidence was missing,
// mis-dated or silently cut, each time because some consumer re-derived
// provenance on its own. These fail the build if any of that comes back.

const SRC = join(process.cwd(), "src");
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}
const rel = (p: string) => relative(process.cwd(), p);

describe("one owner of the session log format", () => {
  // Turning session-log text into rows happens in session-log-rows.ts and
  // nowhere else. A file that both parses JSON and branches on a session
  // row kind is listed here with why its parse is not a session-log parse;
  // a new one fails until someone decides it should go through the reader.
  const NOT_A_SESSION_PARSE: Record<string, string> = {
    "src/memory/session-log-rows.ts": "the owner",
    "src/sync/pull-files/pull-misc.ts": "JSON.parse reads cron job lists; its session rows come from readSessionLogRows",
  };
  it("no file outside the reader parses session-log text", () => {
    const kindCheck = /kind\s*===?\s*['"](msg|meta|summary|checkpoint)['"]/;
    const offenders = sourceFiles().filter((p) => {
      const text = readFileSync(p, "utf8");
      return kindCheck.test(text) && text.includes("JSON.parse(") && !(rel(p) in NOT_A_SESSION_PARSE);
    }).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("one way a session becomes search chunks", () => {
  it("only buildSessionChunks chunks or dates a session; other conversation chunking is imports", () => {
    const offenders: string[] = [];
    for (const p of sourceFiles()) {
      if (rel(p) === "src/memory/chunking.ts") continue;
      const text = readFileSync(p, "utf8");
      if (/withChunkProvenance\(\s*["']session["']/.test(text)) offenders.push(`${rel(p)}: dates session chunks itself`);
      for (const call of text.matchAll(/chunkConversationPairs\(([^;]*?)\)/gs)) {
        if (/["']session["']/.test(call[1])) offenders.push(`${rel(p)}: chunks a session itself`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("every session chunk carries its messages' provenance", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a chunk's time is its opening message's time, its ids are its messages', and an unknown time is flagged", () => {
    dir = mkdtempSync(join(tmpdir(), "lax-prov-contract-"));
    mkdirSync(join(dir, "sessions"));
    const rows: Array<{ id: string; role: string; createdAt: string; timeUnknown?: true; content: string }> = [];
    for (let i = 0; i < 12; i++) {
      const unknown = i % 4 === 3;
      const t = new Date(Date.UTC(2026, 9, 1 + i, 9, i)).toISOString();
      rows.push({ id: `um-${i}`, role: "user", createdAt: t, content: `question number ${i} about the car ride`, ...(unknown ? { timeUnknown: true as const } : {}) });
      rows.push({ id: `am-${i}`, role: "assistant", createdAt: t, content: `answer number ${i}`, ...(unknown ? { timeUnknown: true as const } : {}) });
    }
    const path = join(dir, "sessions", "chat-c.jsonl");
    writeFileSync(path, [JSON.stringify({ kind: "meta", id: "chat-c", title: "c", createdAt: Date.UTC(2026, 8, 30), updatedAt: 0 }),
      ...rows.map((r) => JSON.stringify({ kind: "msg", id: r.id, message: { role: r.role, content: r.content }, createdAt: r.createdAt, ...(r.timeUnknown ? { timeUnknown: true } : {}) }))].join("\n") + "\n");
    const byId = new Map(rows.map((r) => [r.id, r]));
    const chunks = buildSessionChunks(path, "chat-c");
    expect(chunks).toHaveLength(12);
    for (const c of chunks) {
      const m = c.metadata!;
      const opening = byId.get(m.message_ids![0])!;
      expect(m.message_ids!.every((id) => byId.has(id))).toBe(true);
      if (opening.timeUnknown) {
        expect(m).toMatchObject({ date_approx: true, date: "2026-09-30" });
        expect(m.datetime).toBeUndefined();
      } else {
        expect(m.datetime).toBe(opening.createdAt);
        expect(m.date).toBe(opening.createdAt.slice(0, 10));
        expect(m.date_approx).toBeUndefined();
      }
    }
  });
});

describe("a cut snippet always says it was cut", () => {
  it("for any chunk length and query, the snippet is whole with no window, or windowed and marked", () => {
    const base = "alpha beta gamma delta ".repeat(200);
    for (const len of [10, 499, 700, 701, 1500, 4600]) {
      for (const query of [undefined, "gamma", "absent-term", "delta alpha"]) {
        const text = base.slice(0, len);
        const r = toSearchResult({ path: "p", source: "session", startLine: 1, endLine: 1, text, hash: "h", score: 1 } as Chunk & { score: number }, 700, query);
        if (text.length <= 700) {
          expect(r.snippet).toBe(text);
          expect(r.snippetWindow).toBeUndefined();
        } else {
          expect(r.snippetWindow).toMatchObject({ total: text.length });
          expect(r.snippetWindow!.end - r.snippetWindow!.start).toBe(700);
          expect(r.snippet.startsWith("…")).toBe(r.snippetWindow!.start > 0);
          expect(r.snippet.endsWith("…")).toBe(r.snippetWindow!.end < text.length);
        }
      }
    }
  });
});
