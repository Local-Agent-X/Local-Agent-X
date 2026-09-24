import { describe, it, expect, afterEach, vi } from "vitest";

import { streamViaAPI } from "./stream-api.js";
import { resetClaudeCodeVersionForTest } from "./oauth-direct.js";
import type { StreamEvent } from "./types.js";

/**
 * A model whose claude-code version floor is above the one we send 400s naming
 * the floor. The request is resent ONCE with that version, in the same turn —
 * a user who never installed the `claude` CLI must not have to (Opus 5.5,
 * 2026-09-23). See oauth-direct.test.ts for the adoption rules.
 */
describe("version-floor 400 on the direct-OAuth path", () => {
  const OK = [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const floor = (required: string) => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `Claude Code 2.1.280 does not support this model; version ${required} or newer is required. Run 'claude update', or update the Claude desktop app, then try again.` } });

  afterEach(() => { vi.unstubAllGlobals(); resetClaudeCodeVersionForTest(); });

  async function collect(token: string): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const ev of streamViaAPI({ token, model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], systemPrompt: "test" })) out.push(ev);
    return out;
  }

  function stubFloor(required: string): string[] {
    const agents: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const ua = (init.headers as Record<string, string>)["user-agent"] ?? "";
      agents.push(ua);
      return ua.includes(`claude-code/${required} `) ? new Response(OK, { status: 200 }) : new Response(floor(required), { status: 400 });
    }));
    return agents;
  }

  it("adopts the named version and retries once; the turn streams normally", async () => {
    const agents = stubFloor("2.1.300");
    const events = await collect("direct-oauth:tok");
    expect(agents).toEqual(["claude-code/2.1.280 (external, cli)", "claude-code/2.1.300 (external, cli)"]);
    expect(events.some(e => e.type === "text")).toBe(true);
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  it("later requests start at the adopted version — no repeat 400", async () => {
    const agents = stubFloor("2.1.300");
    await collect("direct-oauth:tok");
    await collect("direct-oauth:tok");
    expect(agents).toHaveLength(3);
    expect(agents[2]).toContain("2.1.300");
  });

  it("a floor we already send is surfaced as the plain error, once — no loop", async () => {
    const fetchMock = vi.fn(async () => new Response(floor("2.1.280"), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const events = await collect("direct-oauth:tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const err = events.find(e => e.type === "error") as { error: string } | undefined;
    expect(err?.error).toMatch(/^Anthropic 400: .*2\.1\.280 or newer is required/);
  });

  it("an API-key 400 is untouched — no retry", async () => {
    const fetchMock = vi.fn(async () => new Response(floor("2.1.300"), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await collect("sk-ant-api03-test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
