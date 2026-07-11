import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import { falseRefusalMiddleware, looksLikeFalseFileRefusal } from "./false-refusal.js";
import { loadFileAccessMode } from "../../security/layer/security-config.js";

vi.mock("../../security/layer/security-config.js", () => ({
  loadFileAccessMode: vi.fn(() => "unrestricted"),
}));
const mockMode = loadFileAccessMode as unknown as ReturnType<typeof vi.fn>;

let opCounter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `op-${opCounter++}`, type: "chat_turn", lane: "interactive" },
    turnIdx: 1,
    toolCalls: [],
    toolsCalledThisOp: new Set<string>(),
    attemptedToolsThisOp: new Set<string>(),
    userMessage: "read ~/Documents/notes.txt and show me the first line",
    assistantContent: "I can't access that file — it's outside the workspace sandbox.",
    ...over,
  } as unknown as CanonicalLoopContext;
}
const fire = (c: CanonicalLoopContext) => falseRefusalMiddleware.afterModelCall!(c);

beforeEach(() => mockMode.mockReturnValue("unrestricted"));

describe("false-refusal middleware", () => {
  it("nudges a file refusal made tool-lessly in unrestricted mode without trying read", async () => {
    const res = await fire(ctx());
    expect(res.kind).toBe("nudge");
    if (res.kind === "nudge") {
      expect(res.reason).toBe("false-refusal-grounding");
      expect(res.message).toMatch(/UNRESTRICTED/);
      expect(res.message).toMatch(/call `read`/i);
    }
  });

  it("continues when the turn still requested tools", async () => {
    expect((await fire(ctx({ toolCalls: [{} as never] }))).kind).toBe("continue");
  });

  it("continues when read WAS attempted this op (a real block is a legit report, not a guess)", async () => {
    expect((await fire(ctx({ attemptedToolsThisOp: new Set(["read"]) }))).kind).toBe("continue");
    expect((await fire(ctx({ attemptedToolsThisOp: new Set(["ari_file"]) }))).kind).toBe("continue");
  });

  it("continues in workspace/common mode (a refusal there can be a correct out-of-roots report)", async () => {
    mockMode.mockReturnValue("workspace");
    expect((await fire(ctx())).kind).toBe("continue");
    mockMode.mockReturnValue("common");
    expect((await fire(ctx())).kind).toBe("continue");
  });

  it("continues on an ethical refusal", async () => {
    expect((await fire(ctx({ assistantContent: "I won't access that file for you." }))).kind).toBe("continue");
  });

  it("continues on a no-tool capability denial (that's tool-search-nudge's job)", async () => {
    expect((await fire(ctx({ assistantContent: "I don't have a tool to control the mouse." }))).kind).toBe("continue");
  });

  it("continues on a normal informative answer", async () => {
    expect((await fire(ctx({ assistantContent: "The first line of the file is: hello world." }))).kind).toBe("continue");
  });

  it("fires at most once per op", async () => {
    const c = ctx();
    expect((await fire(c)).kind).toBe("nudge");
    expect((await fire(c)).kind).toBe("continue");
  });
});

describe("looksLikeFalseFileRefusal", () => {
  const positives = [
    "I can't access that file — it's outside the workspace sandbox.",
    "That path is outside my allowed directories.",
    "I'm unable to read the file at that location.",
    "I don't have permission to read that file.",
    "Sorry, that file is off-limits.",
    "I cannot open the document — it's restricted.",
  ];
  for (const t of positives) {
    it(`positive: ${JSON.stringify(t)}`, () => expect(looksLikeFalseFileRefusal(t)).toBe(true));
  }
  const negatives = [
    "The first line of the file is: hello world.",
    "I don't have a tool to control the mouse.",       // no-tool denial → tool-search-nudge
    "I won't access that file for you.",                // ethical
    "Here's a summary of the document you asked about.",
    "",
  ];
  for (const t of negatives) {
    it(`negative: ${JSON.stringify(t)}`, () => expect(looksLikeFalseFileRefusal(t)).toBe(false));
  }
});
