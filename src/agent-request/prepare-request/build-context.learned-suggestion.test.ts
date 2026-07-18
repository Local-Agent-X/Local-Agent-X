import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryManager } from "../../memory/index.js";

const suggestionMock = vi.hoisted(() => vi.fn());
vi.mock("../../protocols/learned-suggestion.js", () => ({
  getLearnedProtocolSuggestion: suggestionMock,
}));

import { buildContext, type BuildContextInput } from "./build-context.js";

function manager(): MemoryManager {
  return {
    buildTurnContext: vi.fn(async () => ({
      contextBlock: "profile", relevantMemories: "memory", smartContext: "existing smart context",
      memoryContext: "memory context", notifications: [], knownProjectsFound: true,
    })),
  } as unknown as MemoryManager;
}

function input(message: string, tier: "weak" | "strong" = "strong"): BuildContextInput {
  return {
    message, sessionId: `session-${message}`, sessionMessages: [], memoryManager: manager(),
    isCodexProvider: false, isTrivialToolRequest: false, tier, resolvedModel: "test-model",
  };
}

describe("buildContext learned workflow selection", () => {
  beforeEach(() => {
    suggestionMock.mockReset();
    suggestionMock.mockReturnValue({ name: "learned-release", score: 10, nudge: "short learned nudge" });
  });

  it("evaluates every user message and appends the short nudge", async () => {
    const first = await buildContext(input("first release checksum request"));
    const second = await buildContext(input("second release checksum request"));
    expect(suggestionMock).toHaveBeenNthCalledWith(1, "first release checksum request");
    expect(suggestionMock).toHaveBeenNthCalledWith(2, "second release checksum request");
    expect(first.smartContext).toBe("existing smart context\n\nshort learned nudge");
    expect(second.smartContext).toContain("short learned nudge");
  });

  it("retains the nudge after weak-tier memory stripping", async () => {
    const result = await buildContext(input("release checksum request", "weak"));
    expect(result.contextBlock).toBe("");
    expect(result.relevantMemories).toBe("");
    expect(result.memoryContext).toBe("");
    expect(result.smartContext).toBe("short learned nudge");
  });

  it("adds nothing when selection fails closed", async () => {
    suggestionMock.mockReturnValue(null);
    const result = await buildContext(input("unrelated request"));
    expect(result.smartContext).toBe("existing smart context");
  });
});
