/**
 * Conversation ingest seam: export files (external, varied formats) meeting the
 * memory system. Covers format detection, parsing correctness, and the
 * scan → parse → index → dedup pipeline — the path that imports ChatGPT/Claude
 * history. Format parsers are exactly where a schema drift breaks imports
 * silently, so they get pinned here.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ingest fires background fact-extraction fire-and-forget; stub it so the test
// neither pulls the heavy extraction stack nor leaks async work past teardown.
vi.mock("../memory/extract.js", () => ({
  runExtraction: vi.fn(async () => ({
    sessionsAnalyzed: 0,
    factsExtracted: 0,
    operations: { add: 0, update: 0, delete: 0, noop: 0 },
  })),
}));

import { detectFormat, parseExportFile } from "./parsers.js";
import { ingestConversations } from "./ingest.js";

// Minimal ChatGPT export: synthetic root → user → assistant. Stable `id` so a
// re-ingest dedups (ChatGPT is the format with a deterministic conversation id).
function chatgptFixture(id = "conv-1"): string {
  return JSON.stringify([
    {
      id,
      title: "Test",
      mapping: {
        root: { parent: null, children: ["m1"] },
        m1: { parent: "root", children: ["m2"], message: { author: { role: "user" }, content: { parts: ["what is 2+2"] } } },
        m2: { parent: "m1", children: [], message: { author: { role: "assistant" }, content: { parts: ["4"] } } },
      },
    },
  ]);
}

describe("detectFormat", () => {
  it("detects chatgpt by mapping tree", () => {
    expect(detectFormat(chatgptFixture(), ".json")).toBe("chatgpt");
  });
  it("detects generic role/content arrays", () => {
    const c = JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]);
    expect(detectFormat(c, ".json")).toBe("generic-json");
  });
  it("detects claude-ai by chat_messages", () => {
    expect(detectFormat(JSON.stringify([{ chat_messages: [] }]), ".json")).toBe("claude-ai");
  });
  it("detects claude-code jsonl by per-line type", () => {
    expect(detectFormat('{"type":"user"}\n{"type":"assistant"}', ".jsonl")).toBe("claude-code");
  });
  it("returns unknown for unrecognized noise", () => {
    expect(detectFormat("just notes\nnothing structured here", ".txt")).toBe("unknown");
  });
});

describe("parseExportFile", () => {
  it("parses a generic role/content array into one conversation", () => {
    const convos = parseExportFile(
      JSON.stringify([
        { role: "user", content: "remember my dog is Rex" },
        { role: "assistant", content: "got it" },
      ]),
      ".json",
    );
    expect(convos).toHaveLength(1);
    expect(convos[0].source).toBe("generic-json");
    expect(convos[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("walks a ChatGPT mapping tree root → user → assistant", () => {
    const convos = parseExportFile(chatgptFixture("conv-9"), ".json");
    expect(convos).toHaveLength(1);
    expect(convos[0].id).toBe("conv-9");
    expect(convos[0].messages).toHaveLength(2);
    expect(convos[0].messages[1]).toMatchObject({ role: "assistant", content: "4" });
  });

  it("returns nothing for an unknown format", () => {
    expect(parseExportFile("garbage with no structure", ".txt")).toEqual([]);
  });
});

describe("stable conversation ids — dedup across re-imports", () => {
  const genericConvo = JSON.stringify([
    { role: "user", content: "what's the capital of France" },
    { role: "assistant", content: "Paris" },
  ]);

  it("generic-json gets a deterministic content-hash id (was Date.now())", () => {
    const a = parseExportFile(genericConvo, ".json")[0].id;
    const b = parseExportFile(genericConvo, ".json")[0].id;
    expect(a).toBe(b);
    expect(a).toMatch(/^generic-json-[0-9a-f]{16}$/);
  });

  it("distinct conversations get distinct ids", () => {
    const other = JSON.stringify([
      { role: "user", content: "what's the capital of Spain" },
      { role: "assistant", content: "Madrid" },
    ]);
    expect(parseExportFile(genericConvo, ".json")[0].id).not.toBe(parseExportFile(other, ".json")[0].id);
  });

  it("claude-code jsonl re-parses to the same id", () => {
    const jsonl = '{"type":"user","message":{"content":"hi there"}}\n{"type":"assistant","message":{"content":"hello back"}}';
    const a = parseExportFile(jsonl, ".jsonl")[0]?.id;
    expect(a).toBeDefined();
    expect(a).toBe(parseExportFile(jsonl, ".jsonl")[0]?.id);
  });

  it("two different single Claude.ai conversations don't collide (was the constant-id bug)", () => {
    const one = JSON.stringify({ messages: [{ role: "user", content: "convo one" }, { role: "assistant", content: "reply one" }] });
    const two = JSON.stringify({ messages: [{ role: "user", content: "convo two" }, { role: "assistant", content: "reply two" }] });
    const idOne = parseExportFile(one, ".json")[0]?.id;
    const idTwo = parseExportFile(two, ".json")[0]?.id;
    expect(idOne).toBeDefined();
    expect(idTwo).toBeDefined();
    expect(idOne).not.toBe(idTwo);
  });
});

describe("ingestConversations — scan → parse → index → dedup", () => {
  function stubMemory() {
    const ingested = new Set<string>();
    return {
      isConversationIngested: (id: string) => ingested.has(id),
      markConversationIngested: (id: string) => { ingested.add(id); },
      indexChunks: vi.fn(async () => {}),
    };
  }

  it("indexes a fresh export, then skips it on a second pass (ChatGPT stable id)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-ingest-"));
    try {
      writeFileSync(join(dir, "export.json"), chatgptFixture("conv-dedup"), "utf-8");
      const mem = stubMemory();

      const r1 = await ingestConversations(mem as never, dir);
      expect(r1.processed).toBe(1);
      expect(r1.chunksCreated).toBeGreaterThan(0);
      expect(mem.indexChunks).toHaveBeenCalledTimes(1);

      // Same file, same conversation id → skipped, nothing re-indexed.
      const r2 = await ingestConversations(mem as never, dir);
      expect(r2.processed).toBe(0);
      expect(r2.skipped).toBe(1);
      expect(mem.indexChunks).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-importing a generic-json export now skips it (the Date.now() id bug)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-ingest-"));
    try {
      writeFileSync(join(dir, "g.json"), JSON.stringify([
        { role: "user", content: "remember my cat is Mochi" },
        { role: "assistant", content: "noted — Mochi" },
      ]), "utf-8");
      const mem = stubMemory();

      const r1 = await ingestConversations(mem as never, dir);
      expect(r1.processed).toBe(1);

      const r2 = await ingestConversations(mem as never, dir);
      expect(r2.processed).toBe(0);
      expect(r2.skipped).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
