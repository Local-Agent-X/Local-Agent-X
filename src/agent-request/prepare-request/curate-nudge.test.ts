// The teach-moment classifier is launched before the turn's own request. On a
// local runtime that answers one request at a time it must not land on the
// turn's model, or the reply waits behind it (voice call 2026-11-05: 2 s before
// every spoken reply).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectAndBoostCurate, type CurateNudgeInput } from "./curate-nudge.js";

const classifyTeachMoment = vi.fn(async () => null);
let backgroundModel = "";
vi.mock("../../memory/curate-classifier.js", () => ({ classifyTeachMoment }));
vi.mock("../../providers/background-model.js", () => ({
  resolveBackgroundModel: async (_provider: string, fallback: string) => ({ model: backgroundModel || fallback }),
}));

const input = (resolvedProvider: string, resolvedModel: string): CurateNudgeInput => ({
  message: "you need to toggle to the other view first",
  sessionMessages: [{ role: "assistant", content: "Opened it." }],
  sessionId: `curate-${Math.random()}`,
  resolvedProvider,
  resolvedModel,
  resolvedApiKey: "",
});

beforeEach(() => { classifyTeachMoment.mockClear(); backgroundModel = ""; });

describe("detectAndBoostCurate — the classifier never queues ahead of its own local turn", () => {
  it("skips the classifier when it would run on the local model the turn is about to use", async () => {
    await detectAndBoostCurate(input("local", "qwen3.8:27b-172k"));
    expect(classifyTeachMoment).not.toHaveBeenCalled();
  });

  it("runs it when a local classifier model is pinned apart from the chat model", async () => {
    backgroundModel = "qwen3:4b";
    await detectAndBoostCurate(input("local", "qwen3.8:27b-172k"));
    expect(classifyTeachMoment).toHaveBeenCalledOnce();
  });

  it("runs it for a cloud chat", async () => {
    await detectAndBoostCurate(input("anthropic", "claude-opus-5-5"));
    expect(classifyTeachMoment).toHaveBeenCalledOnce();
  });
});
