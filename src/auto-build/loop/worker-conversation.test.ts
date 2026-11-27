// A worker's conversation lived in memory only, so a Pause, a Resume or a
// restart of LAX began the next round with a worker that read the whole chunk
// again (the owner saw its token count start over, 2026-11-26).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { carriedConversation, dropWorkerConversation, loadWorkerConversation, saveWorkerConversation } from "./worker-conversation.js";

const DATA = mkdtempSync(join(tmpdir(), "lax-worker-conv-"));
const prior = process.env.LAX_DATA_DIR;
beforeAll(() => { process.env.LAX_DATA_DIR = DATA; });
afterAll(() => {
  if (prior === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prior;
  rmSync(DATA, { recursive: true, force: true });
});

const talk: ChatCompletionMessageParam[] = [
  { role: "user", content: "build chunk 4" },
  { role: "assistant", content: "I read src/ai/adapter.ts and wrote the adapter." },
];
const store = () => join(DATA, "auto-build", "worker-conversations");

describe("a chunk worker's conversation, kept between rounds", () => {
  it("is read back as it was saved, per project and per chunk, and is gone once dropped", () => {
    saveWorkerConversation("C:/apps/label-check", 4, talk);
    expect(loadWorkerConversation("C:/apps/label-check", 4)).toEqual(talk);
    // Another chunk of the project, and the same chunk of another project, have none.
    expect(loadWorkerConversation("C:/apps/label-check", 5)).toBeUndefined();
    expect(loadWorkerConversation("C:/apps/shop-helper", 4)).toBeUndefined();
    // The same project named with other slashes and case is the same project.
    expect(loadWorkerConversation("c:\\apps\\Label-Check", 4)).toEqual(talk);

    dropWorkerConversation("C:/apps/label-check", 4);
    expect(loadWorkerConversation("C:/apps/label-check", 4)).toBeUndefined();
  });

  it("lives in LAX's data folder, never in the project, where another worker could read it", () => {
    const project = mkdtempSync(join(tmpdir(), "lax-worker-conv-project-"));
    try {
      saveWorkerConversation(project, 1, talk);
      expect(readdirSync(project)).toEqual([]);
      expect(readdirSync(store()).length).toBeGreaterThan(0);
    } finally {
      dropWorkerConversation(project, 1);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("a file that is cut off or is not a conversation reads as none, and a save never throws", () => {
    saveWorkerConversation("C:/apps/broken", 2, talk);
    const file = join(store(), readdirSync(store()).find((f) => f.endsWith("-c2.json"))!);
    writeFileSync(file, "[{\"role\":\"user\",\"content\":\"bui");
    expect(loadWorkerConversation("C:/apps/broken", 2)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ not: "a list" }));
    expect(loadWorkerConversation("C:/apps/broken", 2)).toBeUndefined();
    writeFileSync(file, "[]");
    expect(loadWorkerConversation("C:/apps/broken", 2)).toBeUndefined();
  });

  // label-check-sol, 2026-11-26: GPT workers opened fix rounds at 150k to 250k
  // tokens, the whole earlier conversation with every file it had read.
  it("is carried into the next round with its earlier tool output stubbed, and what the worker said and did kept", () => {
    const dump = "x".repeat(40_000);
    const conversation: ChatCompletionMessageParam[] = [
      { role: "user", content: "Build chunk 2." },
      { role: "assistant", content: "Reading the rules.", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"firestore.rules"}' } }] } as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "c1", content: dump } as ChatCompletionMessageParam,
      { role: "assistant", content: "Rules rewritten; tests pass." },
    ];
    const carried = carriedConversation(conversation);
    expect(carried).toHaveLength(4);
    expect(JSON.stringify(carried).length).toBeLessThan(2_000);
    expect(carried[1]).toEqual(conversation[1]);
    expect(carried[3]).toEqual(conversation[3]);
    expect(String(carried[2].content)).toContain("read");
    // The same bytes every time, so the next round's prompt prefix is stable.
    expect(carriedConversation(conversation)).toEqual(carried);
    expect(conversation[2].content).toBe(dump);
  });

  it("one too large to be worth carrying is not kept, and replaces nothing stale", () => {
    saveWorkerConversation("C:/apps/huge", 3, talk);
    saveWorkerConversation("C:/apps/huge", 3, [{ role: "assistant", content: "x".repeat(5 * 1024 * 1024) }]);
    expect(loadWorkerConversation("C:/apps/huge", 3)).toBeUndefined();
    expect(existsSync(store())).toBe(true);
  });
});
