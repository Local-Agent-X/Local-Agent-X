import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOutputReserve, thinkingOutputReserve } from "./output-reserve.js";
import { OUTPUT_RESERVE_TOKENS, assessRequestFit, describeUnfittableRequest } from "./request-fit.js";
import { toolResultCapChars } from "./tool-result-cap.js";
import { invalidateLocalRuntimes, restoreProjectedLocalRuntime } from "../local-runtimes/cache.js";

let dir: string;

function serve(models: string[]): void {
  const file = join(dir, "runtime.json");
  writeFileSync(file, JSON.stringify({
    kind: "ollama", id: "ollama@127.0.0.1:11434", label: "Ollama",
    endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" }, chatBaseUrl: "http://127.0.0.1:11434/v1",
    models: models.map((id) => ({ id, contextWindow: 65_536, tools: true })), refreshedAt: 1,
  }));
  restoreProjectedLocalRuntime(file);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-reserve-")); });
afterEach(() => { invalidateLocalRuntimes(); rmSync(dir, { recursive: true, force: true }); });

describe("resolveOutputReserve", () => {
  it("a local model whose profile thinks reserves 1/16 of its window, 4k..8k", () => {
    serve(["qwen3.6:27b", "qwen3:8b"]);
    expect(resolveOutputReserve("qwen3.6:27b", 65_536)).toBe(4_096);
    expect(resolveOutputReserve("qwen3.6:27b", 172_032)).toBe(8_192);
    expect(resolveOutputReserve("qwen3:8b", 40_960)).toBe(4_096);
  });

  it("never takes more than a quarter of a small window", () => {
    expect(thinkingOutputReserve(8_192)).toBe(2_048);
    expect(thinkingOutputReserve(2_048)).toBe(OUTPUT_RESERVE_TOKENS);
  });

  it("an unprofiled local model keeps the flat reserve", () => {
    serve(["llama3.2:3b"]);
    expect(resolveOutputReserve("llama3.2:3b", 131_072)).toBe(OUTPUT_RESERVE_TOKENS);
  });

  it("cloud models keep the flat reserve, even one with a thinking profile", () => {
    serve(["qwen3.6:27b"]);
    for (const model of ["gpt-5.6-sol", "claude-opus-5-5", "grok-4.7", "gemini-3.8-flash"]) {
      expect(resolveOutputReserve(model, 1_000_000), model).toBe(OUTPUT_RESERVE_TOKENS);
    }
  });
});

describe("the reserve reaches the sizing math", () => {
  const request = { systemPrompt: "x".repeat(35_000), tools: [], messages: [] };

  it("request-fit budgets and reports the reserve it was given", () => {
    const flat = assessRequestFit({ windowTokens: 14_000, ...request });
    expect(flat).toMatchObject({ verdict: "fits", outputReserveTokens: OUTPUT_RESERVE_TOKENS });
    const thinking = assessRequestFit({ windowTokens: 14_000, ...request, outputReserveTokens: 4_096 });
    expect(thinking.verdict).toBe("too_big");
    expect(describeUnfittableRequest("qwen3:8b", thinking)).toContain("(4,096 reserved for the response)");
  });

  it("tool-result-cap leaves the same reserve out of the message budget", () => {
    expect(toolResultCapChars(65_536, 14_000, 4_096)).toBeLessThan(toolResultCapChars(65_536, 14_000));
    expect(toolResultCapChars(65_536, 14_000)).toBe(toolResultCapChars(65_536, 14_000, OUTPUT_RESERVE_TOKENS));
  });
});
