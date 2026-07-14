// Wire-level structured output on the OpenAI-compat adapter: buildParams
// emits `response_format: json_schema` only when the caller asked for it,
// and the param-rejection self-heal drops it (and only it) when a 400 names
// the param — same single-knob retry contract as tools/reasoning_effort/
// temperature. Unrelated errors must still propagate as error chunks.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIHttpAdapter, isResponseFormatRejection } from "./openai-http.js";
import { markParamUnsupported } from "../types.js";
import type { ProviderRequest, StreamChunk } from "../adapter/types.js";

const createMock = vi.fn();

// The OpenAI SDK is mocked at the client boundary so the tests assert the
// exact create() params without any network.
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

// The learned param-unsupported store persists to ~/.lax — mock it so tests
// are hermetic and mark* calls are observable.
vi.mock("../types.js", () => ({
  hasNoToolSupport: vi.fn(() => false),
  markNoToolSupport: vi.fn(),
  hasParamUnsupported: vi.fn(() => false),
  markParamUnsupported: vi.fn(),
}));

function fakeStream() {
  return {
    controller: { abort: vi.fn() },
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] };
    },
  };
}

function baseReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    apiKey: "sk-test",
    model: "gpt-4o-mini",
    systemPrompt: "sys",
    messages: [{ role: "user", content: "ping" }],
    tools: [],
    ...overrides,
  };
}

// A VALID strict schema — strict mode requires `required` covering every
// property and `additionalProperties: false`, or real OpenAI 400s on it.
const RESPONSE_FORMAT: NonNullable<ProviderRequest["responseFormat"]> = {
  type: "json_schema",
  name: "verdict",
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
  strict: true,
};

async function collect(req: ProviderRequest): Promise<StreamChunk[]> {
  const adapter = new OpenAIHttpAdapter();
  const chunks: StreamChunk[] = [];
  for await (const c of adapter.stream(req)) chunks.push(c);
  return chunks;
}

beforeEach(() => {
  createMock.mockReset();
  vi.mocked(markParamUnsupported).mockClear();
});

describe("buildParams response_format emission", () => {
  it("emits the OpenAI json_schema wire shape when req.responseFormat is set", async () => {
    createMock.mockResolvedValueOnce(fakeStream());
    await collect(baseReq({ responseFormat: RESPONSE_FORMAT }));
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "verdict", schema: RESPONSE_FORMAT.schema, strict: true },
    });
  });

  it("omits strict from the wire shape when the caller leaves it unset", async () => {
    createMock.mockResolvedValueOnce(fakeStream());
    const { strict: _strict, ...noStrict } = RESPONSE_FORMAT;
    await collect(baseReq({ responseFormat: noStrict }));
    expect(createMock.mock.calls[0][0].response_format.json_schema).toEqual({
      name: "verdict",
      schema: RESPONSE_FORMAT.schema,
    });
  });

  it("omits response_format entirely when req.responseFormat is absent", async () => {
    createMock.mockResolvedValueOnce(fakeStream());
    await collect(baseReq());
    expect(createMock).toHaveBeenCalledTimes(1);
    expect("response_format" in createMock.mock.calls[0][0]).toBe(false);
  });
});

describe("response_format 400 self-heal", () => {
  it("unsupported-phrasing 400: drops response_format (and only it), marks the param, retries once", async () => {
    createMock
      .mockRejectedValueOnce(new Error("400 Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model"))
      .mockResolvedValueOnce(fakeStream());
    const chunks = await collect(baseReq({ responseFormat: RESPONSE_FORMAT }));

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0].response_format).toBeDefined();
    const retryParams = createMock.mock.calls[1][0];
    expect("response_format" in retryParams).toBe(false);
    // The other knobs stay exactly as the first call sent them.
    expect(retryParams.tools).toEqual(createMock.mock.calls[0][0].tools);
    expect(retryParams.temperature).toBe(createMock.mock.calls[0][0].temperature);
    expect(vi.mocked(markParamUnsupported)).toHaveBeenCalledWith(undefined, "gpt-4o-mini", "response_format");
    expect(chunks).toContainEqual({ type: "text", delta: "ok" });
  });

  it("schema-validation 400 propagates: no heal, no mark — a bad schema is a caller bug", async () => {
    const schemaError =
      "400 Invalid schema for response_format 'verdict': In context=(), 'additionalProperties' is required to be supplied and to be false.";
    createMock.mockRejectedValueOnce(new Error(schemaError));
    const chunks = await collect(baseReq({ responseFormat: RESPONSE_FORMAT }));
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(chunks[0]).toMatchObject({ type: "error", message: schemaError });
    expect(vi.mocked(markParamUnsupported)).not.toHaveBeenCalled();
  });

  it("invalid response_format field 400 also propagates without healing", async () => {
    const fieldError = "400 Invalid 'response_format.json_schema.name': string does not match pattern.";
    createMock.mockRejectedValueOnce(new Error(fieldError));
    const chunks = await collect(baseReq({ responseFormat: RESPONSE_FORMAT }));
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(chunks[0]).toMatchObject({ type: "error", message: fieldError });
    expect(vi.mocked(markParamUnsupported)).not.toHaveBeenCalled();
  });

  it("does NOT self-heal when we never sent response_format — the error propagates", async () => {
    createMock.mockRejectedValueOnce(new Error("400 response_format is not supported"));
    const chunks = await collect(baseReq());
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(chunks[0]).toMatchObject({ type: "error" });
    expect(vi.mocked(markParamUnsupported)).not.toHaveBeenCalled();
  });

  it("an unrelated 400 with response_format sent still propagates untouched", async () => {
    createMock.mockRejectedValueOnce(new Error("400 context length exceeded"));
    const chunks = await collect(baseReq({ responseFormat: RESPONSE_FORMAT }));
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(chunks[0]).toMatchObject({ type: "error", message: "400 context length exceeded" });
  });
});

describe("isResponseFormatRejection", () => {
  it("matches UNSUPPORTED phrasing in either casing style", () => {
    expect(isResponseFormatRejection("does not support parameter response_format")).toBe(true);
    expect(isResponseFormatRejection("does not support responseFormat")).toBe(true);
    expect(isResponseFormatRejection("Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model")).toBe(true);
    expect(isResponseFormatRejection("Unsupported parameter: 'response_format'")).toBe(true);
  });

  it("does NOT match schema-validation errors that merely name the param", () => {
    expect(isResponseFormatRejection("Invalid schema for response_format 'verdict': 'additionalProperties' is required to be supplied and to be false")).toBe(false);
    expect(isResponseFormatRejection("Invalid 'response_format.json_schema.name': string does not match pattern")).toBe(false);
    expect(isResponseFormatRejection("rate limit exceeded")).toBe(false);
    expect(isResponseFormatRejection(undefined)).toBe(false);
  });
});
