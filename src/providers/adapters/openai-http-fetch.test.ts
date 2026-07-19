import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LAXConfig } from "../../types.js";
import type { ProviderRequest } from "../adapter/types.js";

interface Observation {
  calls: number;
  body: Buffer;
  contentLength: string | undefined;
}

let savedConfig: LAXConfig;
const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "openai-http-fetch-test-"));
process.env.LAX_DATA_DIR = dataDir;
let getRuntimeConfig: typeof import("../../config.js").getRuntimeConfig;
let setRuntimeConfig: typeof import("../../config.js").setRuntimeConfig;
let OpenAIHttpAdapter: typeof import("./openai-http.js").OpenAIHttpAdapter;
let strictFetchFor: typeof import("./openai-http.js").strictFetchFor;

beforeAll(async () => {
  ({ getRuntimeConfig, setRuntimeConfig } = await import("../../config.js"));
  ({ OpenAIHttpAdapter, strictFetchFor } = await import("./openai-http.js"));
  savedConfig = getRuntimeConfig();
  setRuntimeConfig({ ...savedConfig, localOnlyMode: true });
});

afterAll(() => {
  setRuntimeConfig(savedConfig);
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function collect(req: ProviderRequest): Promise<string> {
  let text = "";
  for await (const chunk of new OpenAIHttpAdapter().stream(req)) {
    if (chunk.type === "text") text += chunk.delta;
  }
  return text;
}

async function withOpenAiServer(
  run: (baseURL: string, observed: Observation) => Promise<void>,
): Promise<void> {
  const observed: Observation = { calls: 0, body: Buffer.alloc(0), contentLength: undefined };
  const server: Server = createServer(async (request: IncomingMessage, response) => {
    observed.calls += 1;
    observed.contentLength = request.headers["content-length"];
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observed.body = Buffer.concat(chunks);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}/v1`, observed);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function request(baseURL: string, systemPrompt: string): ProviderRequest {
  return {
    apiKey: "local-test",
    baseURL,
    model: "qualification-test",
    systemPrompt,
    messages: [{ role: "user", content: "ping" }],
    tools: [],
  };
}

describe("local-only OpenAI fetch boundary", () => {
  it("lets native fetch compute content length for a real ~98KB Unicode request", async () => {
    await withOpenAiServer(async (baseURL, observed) => {
      const systemPrompt = "—".repeat(32_700);
      expect(await collect(request(baseURL, systemPrompt))).toBe("ok");
      expect(observed.calls).toBe(1);
      expect(observed.body.byteLength).toBeGreaterThanOrEqual(98_000);
      expect(observed.body.byteLength).toBeLessThan(100_000);
      expect(Number(observed.contentLength)).toBe(observed.body.byteLength);
      const parsed = JSON.parse(observed.body.toString("utf8")) as { messages: Array<{ content: string }> };
      expect(parsed.messages[0].content).toBe(systemPrompt);
    });
  });

  it("preserves one-call delivery for an ordinary small local request", async () => {
    await withOpenAiServer(async (baseURL, observed) => {
      expect(await collect(request(baseURL, "small"))).toBe("ok");
      expect(observed.calls).toBe(1);
      expect(Number(observed.contentLength)).toBe(observed.body.byteLength);
    });
  });

  it("does not install the local-only fetch override for remote or non-strict requests", () => {
    expect(strictFetchFor("https://api.example.test/v1")).toBeUndefined();
    setRuntimeConfig({ ...savedConfig, localOnlyMode: false });
    expect(strictFetchFor("http://127.0.0.1:11434/v1")).toBeUndefined();
    setRuntimeConfig({ ...savedConfig, localOnlyMode: true });
  });
});
