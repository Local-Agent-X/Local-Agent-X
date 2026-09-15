import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { truncateHistory } from "./truncate-history.js";
import { buildCleanHistory } from "./sanitize.js";
import { chatHistoryWindow, CHAT_KEEP, CLOUD_CHAT_KEEP } from "../context-manager/compaction-policy.js";

function conversation(turns: number): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", content: `question ${i}` });
    out.push({ role: "assistant", content: `answer ${i}` });
  }
  return out;
}

const recent = (rows: ChatCompletionMessageParam[]) => rows.filter((m) => m.role !== "system");

describe("chatHistoryWindow", () => {
  it("keeps the legacy one-row slide when the provider is unknown", () => {
    expect(chatHistoryWindow("web")).toEqual({ maxKeep: CHAT_KEEP.web, step: 1 });
  });

  it("local models keep today's cap, stepped", () => {
    expect(chatHistoryWindow("web", "local")).toEqual({ maxKeep: CHAT_KEEP.web, step: CHAT_KEEP.web / 2 });
    expect(chatHistoryWindow("telegram", "local").maxKeep).toBe(CHAT_KEEP.default);
  });

  it("cloud models get the larger stepped window", () => {
    expect(chatHistoryWindow("web", "anthropic")).toEqual({ maxKeep: CLOUD_CHAT_KEEP.web, step: CLOUD_CHAT_KEEP.web / 2 });
    expect(chatHistoryWindow("web", "xai").maxKeep).toBe(CLOUD_CHAT_KEEP.web);
  });
});

describe("truncateHistory — stepped cut", () => {
  it("step 1 is the legacy slide: every new message moves the cut", () => {
    const a = recent(truncateHistory(conversation(30), 40, 1));
    const b = recent(truncateHistory(conversation(31), 40, 1));
    expect(a[0].content).not.toBe(b[0].content);
  });

  it("a stepped cut stays put across new messages, so the kept rows stay a prefix", () => {
    const a = recent(truncateHistory(conversation(31), 40, 20));
    const b = recent(truncateHistory(conversation(35), 40, 20));
    expect(b[0].content).toBe(a[0].content);
    expect(b.slice(0, a.length)).toEqual(a);
  });

  it("never keeps more rows than maxKeep", () => {
    for (let turns = 20; turns <= 80; turns++) {
      const kept = recent(truncateHistory(conversation(turns), 40, 20));
      expect(kept.length).toBeLessThanOrEqual(40);
      expect(kept.length).toBeGreaterThan(0);
    }
  });

  it("buildCleanHistory honors an explicit maxHistory exactly, unstepped", () => {
    const kept = recent(buildCleanHistory(conversation(40), "telegram", 30, "local"));
    expect(kept.length).toBe(30);
  });
});
