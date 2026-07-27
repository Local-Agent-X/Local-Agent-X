// The `claude` CLI subprocess is no longer a supported way to connect.
// Subscription credentials must reach Anthropic over direct HTTPS instead.
//
// Regression this pins (2026-07-26): routing was decided from credential
// SHAPE and never checked that the binary existed. On a box with no `claude`
// on PATH the spawn died instantly, the turn hung forever waiting on a frame
// that would never arrive, and the cap-1 background lane wedged — six queued
// dreams were failed by the next boot sweep having never run a single turn.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StreamEvent, StreamOptions } from "./types.js";

const streamViaAPI = vi.fn();
const streamViaCliWithTools = vi.fn();
const resolveWrappedDirectToken = vi.fn();

vi.mock("./stream-api.js", () => ({
  streamViaAPI: (o: StreamOptions) => streamViaAPI(o),
}));
vi.mock("./stream-cli.js", () => ({
  streamViaCliWithTools: (o: StreamOptions) => streamViaCliWithTools(o),
}));
vi.mock("./oauth-direct.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./oauth-direct.js")>();
  return { ...actual, resolveWrappedDirectToken: () => resolveWrappedDirectToken() };
});

async function* yields(...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

function opts(token: string): StreamOptions {
  return { token, model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] } as StreamOptions;
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("Anthropic CLI transport is hidden", () => {
  let streamAnthropicResponse: typeof import("./stream.js").streamAnthropicResponse;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.LAX_ANTHROPIC_CLI_TRANSPORT;
    streamViaAPI.mockImplementation(() => yields({ type: "text", delta: "ok" }, { type: "done" }));
    streamViaCliWithTools.mockImplementation(() => yields({ type: "text", delta: "cli" }, { type: "done" }));
    ({ streamAnthropicResponse } = await import("./stream.js"));
  });

  afterEach(() => { delete process.env.LAX_ANTHROPIC_CLI_TRANSPORT; });

  it("sends an `oauth:` subscription bearer over direct HTTP, never the subprocess", async () => {
    await drain(streamAnthropicResponse(opts("oauth:sk-ant-oat-abc123")));

    expect(streamViaCliWithTools).not.toHaveBeenCalled();
    expect(streamViaAPI).toHaveBeenCalledTimes(1);
    // Wrapped so streamViaAPI dons Claude Code's identity (plan billing)
    // rather than sending the bearer as an x-api-key.
    expect(streamViaAPI.mock.calls[0][0].token).toBe("direct-oauth:sk-ant-oat-abc123");
  });

  it("re-resolves a bearer for the token-less `cli` sentinel", async () => {
    resolveWrappedDirectToken.mockResolvedValue("direct-oauth:from-store");

    await drain(streamAnthropicResponse(opts("cli")));

    expect(streamViaCliWithTools).not.toHaveBeenCalled();
    expect(streamViaAPI.mock.calls[0][0].token).toBe("direct-oauth:from-store");
  });

  it("surfaces an auth error instead of spawning when no bearer can be resolved", async () => {
    resolveWrappedDirectToken.mockResolvedValue(null);

    const events = await drain(streamAnthropicResponse(opts("cli")));

    expect(streamViaCliWithTools).not.toHaveBeenCalled();
    expect(streamViaAPI).not.toHaveBeenCalled();
    expect(events[0].type).toBe("error");
  });

  it("does NOT fall back to the subprocess when direct HTTP hits a billing rejection", async () => {
    streamViaAPI.mockImplementation(() => yields(
      { type: "error", error: "Anthropic 400: You're out of extra usage" },
      { type: "done" },
    ));

    const events = await drain(streamAnthropicResponse(opts("oauth:sk-ant-oat-abc123")));

    expect(streamViaCliWithTools).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("leaves a real pay-as-you-go API key on the plain x-api-key path", async () => {
    await drain(streamAnthropicResponse(opts("sk-ant-api03-realkey")));

    expect(streamViaCliWithTools).not.toHaveBeenCalled();
    expect(streamViaAPI.mock.calls[0][0].token).toBe("sk-ant-api03-realkey");
  });

  it("still honors the hidden path when explicitly re-enabled", async () => {
    process.env.LAX_ANTHROPIC_CLI_TRANSPORT = "1";

    await drain(streamAnthropicResponse(opts("oauth:sk-ant-oat-abc123")));

    expect(streamViaCliWithTools).toHaveBeenCalledTimes(1);
    expect(streamViaAPI).not.toHaveBeenCalled();
  });
});
