/**
 * Same-provider self-heal for the o-series temperature 400. o1/o3/o-series
 * models reject a non-default `temperature` ("Unsupported value: 'temperature'
 * does not support 0.7 with this model. Only the default (1) value is
 * supported."). The openai-http catch must:
 *   (a) fire ONLY on that specific rejection (every other 400 re-throws), and
 *   (b) mark temperature unsupported and retry ONCE without the temperature
 *       field, so the retried stream succeeds.
 * A subsequent call for the same (baseURL, model) must then omit temperature
 * up front via the hasParamUnsupported short-circuit.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture every params body passed to chat.completions.create so we can assert
// what the initial call vs. the retry sent. The mock is programmable per-call.
const createMock = vi.fn();
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: (...a: unknown[]) => createMock(...a) } };
  },
}));

const { OpenAIHttpAdapter, isTemperatureRejection } = await import(
  "../src/providers/adapters/openai-http.js"
);
const { hasParamUnsupported, _resetUnsupportedParamsForTests } = await import(
  "../src/providers/types.js"
);

// An o-series temperature rejection — what OpenAI actually returns for o3.
const TEMP_400 =
  "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.";

function fakeStream() {
  return (async function* () {
    yield { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] };
  })();
}

// A non-x.ai endpoint with a plain "o3" model: not reasoning-capable under the
// adapter's local fallback regex, so reasoning_effort is never in play and the
// test isolates the temperature knob.
const baseURL = "https://api.openai.example/v1";
const model = "o3";
function makeReq() {
  return {
    apiKey: "k",
    baseURL,
    model,
    systemPrompt: "sys",
    messages: [{ role: "user" as const, content: "hello" }],
    tools: [],
    temperature: 0.7,
  } as never;
}

async function drain(adapter: OpenAIHttpAdapter, req: ReturnType<typeof makeReq>) {
  const chunks = [];
  for await (const c of adapter.stream(req)) chunks.push(c);
  return chunks;
}

describe("openai-http temperature self-heal", () => {
  beforeEach(() => {
    createMock.mockReset();
    _resetUnsupportedParamsForTests();
  });

  it("marks temperature unsupported and retries WITHOUT the field on an o-series 400", async () => {
    // First call 400s on temperature; the retry (no temperature) succeeds.
    createMock
      .mockRejectedValueOnce(new Error(TEMP_400))
      .mockResolvedValueOnce(fakeStream());

    const adapter = new OpenAIHttpAdapter();
    const chunks = await drain(adapter, makeReq());

    // Two create() calls: the failed initial one and the self-heal retry.
    expect(createMock).toHaveBeenCalledTimes(2);

    const firstBody = createMock.mock.calls[0][0] as Record<string, unknown>;
    const retryBody = createMock.mock.calls[1][0] as Record<string, unknown>;
    expect(firstBody.temperature).toBe(0.7); // initial call DID send it
    expect("temperature" in retryBody).toBe(false); // retry OMITS the field entirely

    // The cache now remembers this (baseURL, model) rejects temperature.
    expect(hasParamUnsupported(baseURL, model, "temperature")).toBe(true);

    // The retried stream actually flowed through to the caller.
    expect(chunks.some((c) => c.type === "text" && c.delta === "hi")).toBe(true);
    expect(chunks.some((c) => c.type === "done")).toBe(true);
  });

  it("does NOT self-heal an unrelated 400 — it re-throws (surfaced as an error chunk)", async () => {
    createMock.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    const adapter = new OpenAIHttpAdapter();
    const chunks = await drain(adapter, makeReq());

    // No retry — the unrelated error propagates.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(hasParamUnsupported(baseURL, model, "temperature")).toBe(false);
    const err = chunks.find((c) => c.type === "error") as { message: string } | undefined;
    expect(err?.message).toContain("Rate limit");
  });

  it("omits temperature up front on a subsequent call once the rejection is cached", async () => {
    // Prime the cache with a self-heal.
    createMock
      .mockRejectedValueOnce(new Error(TEMP_400))
      .mockResolvedValueOnce(fakeStream());
    const adapter = new OpenAIHttpAdapter();
    await drain(adapter, makeReq());
    expect(hasParamUnsupported(baseURL, model, "temperature")).toBe(true);

    // Next call: a single successful create() that already omits temperature.
    createMock.mockReset();
    createMock.mockResolvedValueOnce(fakeStream());
    await drain(adapter, makeReq());

    expect(createMock).toHaveBeenCalledTimes(1); // no failed round-trip
    const body = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect("temperature" in body).toBe(false);
  });
});

describe("isTemperatureRejection — scopes the temperature retry", () => {
  it("matches the o-series rejection", () => {
    expect(isTemperatureRejection(TEMP_400)).toBe(true);
    expect(
      isTemperatureRejection("temperature is not supported with this model; only the default value is supported"),
    ).toBe(true);
    expect(isTemperatureRejection("This model does not support temperature.")).toBe(true);
  });

  it("does NOT match unrelated 400s (they must re-throw, not get masked)", () => {
    expect(isTemperatureRejection("Rate limit exceeded")).toBe(false);
    expect(isTemperatureRejection("This model's maximum context length is 131072 tokens")).toBe(false);
    expect(isTemperatureRejection("Incorrect API key provided")).toBe(false);
    expect(isTemperatureRejection("does not support parameter reasoning_effort")).toBe(false);
    expect(isTemperatureRejection(undefined)).toBe(false);
    expect(isTemperatureRejection("")).toBe(false);
  });
});
