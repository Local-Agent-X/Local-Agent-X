import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import { attributionClaimMiddleware, looksLikeAttributionClaim } from "./attribution-claim.js";
import { verifyAttributionConfabulationWithLLM } from "../../classifiers/claim-verify.js";

vi.mock("../../classifiers/claim-verify.js", () => ({
  verifyAttributionConfabulationWithLLM: vi.fn(async () => true),
}));
const mockVerify = verifyAttributionConfabulationWithLLM as unknown as ReturnType<typeof vi.fn>;

// The real confabulation from the live failure.
const CONFAB = 'I created a 4-slide presentation that combines all four tools you mentioned ' +
  '(Runway Gen-3 cinematic style, Kling-level depth, Luma/Pika speed) into one cohesive artifact.';

let opCounter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `op-${opCounter++}`, type: "chat_turn", lane: "interactive" },
    turnIdx: 1,
    toolCalls: [],
    toolsCalledThisOp: new Set(["web_search", "image_search", "presentation"]),
    attemptedToolsThisOp: new Set(["web_search", "image_search", "presentation"]),
    userMessage: "combine all 4. topic is man's place in the universe",
    assistantContent: CONFAB,
    ...over,
  } as unknown as CanonicalLoopContext;
}
const fire = (c: CanonicalLoopContext) => attributionClaimMiddleware.afterModelCall!(c);

beforeEach(() => mockVerify.mockReset().mockResolvedValue(true));

describe("attribution-claim middleware", () => {
  it("nudges (and is retractable) when the verifier confirms a confabulated attribution", async () => {
    const res = await fire(ctx());
    expect(res.kind).toBe("nudge");
    if (res.kind === "nudge") {
      expect(res.reason).toBe("attribution-confabulation");
      expect(res.message).toMatch(/web_search, image_search, presentation/);
      expect(res.message).toMatch(/do not rebuild/i);
    }
  });

  it("passes the ACTUAL tools used to the verifier", async () => {
    await fire(ctx());
    expect(mockVerify).toHaveBeenCalledWith(CONFAB, ["web_search", "image_search", "presentation"]);
  });

  it("continues when the verifier says it's accurate (false)", async () => {
    mockVerify.mockResolvedValue(false);
    expect((await fire(ctx())).kind).toBe("continue");
  });

  it("does NOT nag when the verifier is unavailable (null)", async () => {
    mockVerify.mockResolvedValue(null);
    expect((await fire(ctx())).kind).toBe("continue");
  });

  it("never calls the verifier when there's no attribution phrasing", async () => {
    const res = await fire(ctx({ assistantContent: "Done — I added the file to your workspace and summarized it." }));
    expect(res.kind).toBe("continue");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("fires at most once per op", async () => {
    const c = ctx();
    expect((await fire(c)).kind).toBe("nudge");
    expect((await fire(c)).kind).toBe("continue");
  });

  it("only applies to chat_turn ops", () => {
    expect(attributionClaimMiddleware.when!(ctx())).toBe(true);
    expect(attributionClaimMiddleware.when!(ctx({ op: { id: "v", type: "voice_turn" } as never }))).toBe(false);
    expect(attributionClaimMiddleware.when!(ctx({ op: { id: "w", type: "agent_spawn" } as never }))).toBe(false);
  });
});

describe("looksLikeAttributionClaim", () => {
  const positives = [
    CONFAB,
    "The deck combines all four tools into one artifact.",
    "Rendered in the style of Studio Ghibli.",
    "This site is powered by the Llama model.",
    "Built using the Veo generator and a diffusion engine.",
  ];
  for (const t of positives) {
    it(`positive: ${JSON.stringify(t.slice(0, 50))}`, () => expect(looksLikeAttributionClaim(t)).toBe(true));
  }
  const negatives = [
    "It uses real sourced images and actual quotes instead of generic text.",
    "Done — I added the file to your workspace.",
    "A clean, minimalist layout with warm tones.",
    "I searched the web and built a 4-slide deck about the topic.",
    "",
  ];
  for (const t of negatives) {
    it(`negative: ${JSON.stringify(t.slice(0, 50))}`, () => expect(looksLikeAttributionClaim(t)).toBe(false));
  }
});
