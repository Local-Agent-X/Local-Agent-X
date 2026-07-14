import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { ClassifyOptions } from "./classify-with-llm.js";
import { classifySchema } from "./schema-output.js";

// Mock the underlying classifier so the DEFAULT wiring path (no _llm) is
// testable without a live LLM. Every other test injects _llm and never
// reaches this mock.
const { classifyWithLLMMock } = vi.hoisted(() => ({
  classifyWithLLMMock: vi.fn<(o: ClassifyOptions<string>) => Promise<string | null>>(),
}));
vi.mock("./classify-with-llm.js", () => ({ classifyWithLLM: classifyWithLLMMock }));

const schema = z.object({
  verdict: z.enum(["pass", "fail"]),
  reason: z.string(),
});
const shapeHint = `{"verdict":"pass","reason":"..."}`;

type Llm = (system: string, user: string) => Promise<string | null>;

function opts(llm: Llm) {
  return {
    category: "test-schema",
    systemPrompt: "You judge a thing.",
    userPrompt: "Judge this.",
    schema,
    shapeHint,
    _llm: llm,
  };
}

describe("classifySchema", () => {
  it("returns the validated value on a valid first reply", async () => {
    const llm = vi.fn<Llm>(async () => `{"verdict":"pass","reason":"looks good"}`);
    const result = await classifySchema(opts(llm));
    expect(result).toEqual({ verdict: "pass", reason: "looks good" });
    expect(llm).toHaveBeenCalledTimes(1);
    // The JSON-only instruction and shape hint ride in the system prompt.
    expect(llm.mock.calls[0][0]).toContain("Return ONLY JSON");
    expect(llm.mock.calls[0][0]).toContain(shapeHint);
  });

  it("retries once on an invalid reply, feeding back the zod error", async () => {
    const llm = vi
      .fn<Llm>()
      .mockResolvedValueOnce(`{"verdict":"maybe","reason":"hmm"}`)
      .mockResolvedValueOnce(`{"verdict":"fail","reason":"corrected"}`);
    const result = await classifySchema(opts(llm));
    expect(result).toEqual({ verdict: "fail", reason: "corrected" });
    expect(llm).toHaveBeenCalledTimes(2);
    const retryUser = llm.mock.calls[1][1];
    expect(retryUser).toContain("Your previous reply was invalid:");
    // Zod's error for the bad enum names the offending path.
    expect(retryUser).toContain("verdict");
    expect(retryUser).toContain(`Return ONLY valid JSON matching: ${shapeHint}`);
  });

  it("returns null after two invalid replies — exactly one retry", async () => {
    const llm = vi.fn<Llm>(async () => `{"verdict":"maybe","reason":42}`);
    const result = await classifySchema(opts(llm));
    expect(result).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("unwraps fence-wrapped JSON", async () => {
    const llm = vi.fn<Llm>(
      async () => "```json\n{\"verdict\":\"pass\",\"reason\":\"fenced\"}\n```",
    );
    const result = await classifySchema(opts(llm));
    expect(result).toEqual({ verdict: "pass", reason: "fenced" });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("returns null on non-JSON garbage (after the single retry)", async () => {
    const llm = vi.fn<Llm>(async () => "I think it passes, probably.");
    const result = await classifySchema(opts(llm));
    expect(result).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][1]).toContain("Your previous reply was invalid:");
  });

  it("returns null without retrying when the LLM is unavailable", async () => {
    const llm = vi.fn<Llm>(async () => null);
    const result = await classifySchema(opts(llm));
    expect(result).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("never throws — an exploding llm override resolves to null", async () => {
    const llm = vi.fn<Llm>(async () => {
      throw new Error("boom");
    });
    await expect(classifySchema(opts(llm))).resolves.toBeNull();
  });

  it("treats a throwing schema transform as a validation failure — single retry, then null", async () => {
    // zod's safeParse THROWS (does not envelope) when a .transform throws a
    // non-ZodError. That must consume the normal retry, not zero retries.
    const throwing = z.object({ verdict: z.string() }).transform((): never => {
      throw new Error("transform boom");
    });
    const llm = vi.fn<Llm>(async () => `{"verdict":"pass"}`);
    const result = await classifySchema({ ...opts(llm), schema: throwing });
    expect(result).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][1]).toContain("transform boom");
  });

  it("caps the error summary interpolated into the retry prompt at 500 chars", async () => {
    // The summary derives from model-controlled text and can explode (10k+
    // chars observed) — the retry prompt must get a bounded slice + ellipsis.
    const picky = z.object({ verdict: z.string().refine(() => false, "y".repeat(2000)) });
    const llm = vi.fn<Llm>(async () => `{"verdict":"nope"}`);
    const result = await classifySchema({ ...opts(llm), schema: picky });
    expect(result).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
    const retryUser = llm.mock.calls[1][1];
    expect(retryUser).toContain("Your previous reply was invalid:");
    expect(retryUser).toContain("…");
    expect(retryUser).not.toContain("y".repeat(501));
  });

  it("default path (no _llm) passes options through to classifyWithLLM with an identity parse", async () => {
    classifyWithLLMMock.mockImplementationOnce(async (o) =>
      o.parse(`{"verdict":"pass","reason":"wired"}`),
    );
    const result = await classifySchema({
      category: "wiring",
      systemPrompt: "You judge a thing.",
      userPrompt: "Judge this.",
      schema,
      shapeHint,
      modelTier: "active",
      maxResponseChars: 1234,
      timeoutMs: 999,
      envDisableVar: "LAX_TEST_SCHEMA",
    });
    expect(result).toEqual({ verdict: "pass", reason: "wired" });
    expect(classifyWithLLMMock).toHaveBeenCalledTimes(1);
    const passed = classifyWithLLMMock.mock.calls[0][0];
    expect(passed).toMatchObject({
      category: "wiring",
      userPrompt: "Judge this.",
      modelTier: "active",
      maxResponseChars: 1234,
      timeoutMs: 999,
      envDisableVar: "LAX_TEST_SCHEMA",
    });
    expect(passed.systemPrompt).toContain("You judge a thing.");
    expect(passed.systemPrompt).toContain(shapeHint);
    // Raw-text seam: parse must be identity so the retry loop sees the reply.
    expect(passed.parse("raw text")).toBe("raw text");
  });
});
