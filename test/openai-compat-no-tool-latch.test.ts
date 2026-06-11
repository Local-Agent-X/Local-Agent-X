import { describe, expect, it } from "vitest";
import { shouldLatchNoToolSupport } from "../src/canonical-loop/adapters/openai-compat.js";

// Regression guard (live 2026-06-11): Gemini's OpenAI-compat endpoint returned
// an empty completion when 98 tools were attached. The empty-response retry
// called markNoToolSupport(), which is a PROCESS-WIDE latch — so after one
// empty turn, every later Gemini turn was sent with zero tools and the model
// narrated ("I'll open the browser…") without ever dispatching a call. The
// latch must fire ONLY for loopback/local endpoints (the qwen2:7b case it was
// built for), never for cloud frontier providers.
describe("shouldLatchNoToolSupport — empty-with-tools latch scope", () => {
  it("does NOT latch cloud frontier endpoints (the Gemini bug)", () => {
    expect(shouldLatchNoToolSupport("https://generativelanguage.googleapis.com/v1beta/openai/")).toBe(false);
    expect(shouldLatchNoToolSupport("https://api.x.ai/v1")).toBe(false);
    expect(shouldLatchNoToolSupport("https://api.openai.com/v1")).toBe(false);
    // Ollama Turbo is cloud — its models DO support tools; never latch.
    expect(shouldLatchNoToolSupport("https://ollama.com/v1")).toBe(false);
  });

  it("latches loopback/local endpoints (qwen2:7b genuinely can't do tools)", () => {
    expect(shouldLatchNoToolSupport("http://127.0.0.1:11434/v1")).toBe(true);
    expect(shouldLatchNoToolSupport("http://localhost:11434/v1")).toBe(true);
    expect(shouldLatchNoToolSupport("http://[::1]:11434/v1")).toBe(true);
    expect(shouldLatchNoToolSupport("http://0.0.0.0:11434/v1")).toBe(true);
  });

  it("never latches on missing/garbage baseURL (fail open: keep tools)", () => {
    expect(shouldLatchNoToolSupport(undefined)).toBe(false);
    expect(shouldLatchNoToolSupport("")).toBe(false);
    expect(shouldLatchNoToolSupport("not a url")).toBe(false);
  });

  it("does not latch a remote host whose name merely contains 'localhost'", () => {
    expect(shouldLatchNoToolSupport("https://localhost.evil.com/v1")).toBe(false);
  });
});
