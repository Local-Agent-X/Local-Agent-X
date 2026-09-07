import { describe, it, expect } from "vitest";
import { canonicalToTransport } from "./canonical-to-transport.js";
import type { CanonicalMessage } from "../contract-types.js";

function msg(role: CanonicalMessage["role"], content: unknown, id: string): CanonicalMessage {
  return { messageId: id, role, content };
}

const IMG = { mime: "image/png", b64: "aGVsbG8=" };

describe("canonicalToTransport image-sidecar placement (PR-7)", () => {
  it("keeps parallel tool_result rows adjacent when the FIRST result carries images", () => {
    // Regression (PR-7): the assistant issues two parallel tool calls; the
    // first tool returns a screenshot envelope. Before the fix, the image
    // sidecar user row was pushed BETWEEN the two `tool` rows, so the second
    // tool_result no longer immediately followed the tool_use turn and the
    // Anthropic Messages API rejected the request with a 400.
    const messages: CanonicalMessage[] = [
      msg("user", { text: "take a screenshot and read the file" }, "m1"),
      msg(
        "assistant",
        {
          text: "",
          toolCalls: [
            { id: "tc-1", name: "browser_screenshot", arguments: "{}" },
            { id: "tc-2", name: "read_file", arguments: "{}" },
          ],
        },
        "m2",
      ),
      msg(
        "tool_result",
        { toolCallId: "tc-1", result: { text: "screenshot taken", images: [IMG] } },
        "m3",
      ),
      msg("tool_result", { toolCallId: "tc-2", result: "file contents" }, "m4"),
    ];

    const out = canonicalToTransport(messages, undefined);
    const roles = out.map((m) => m.role);

    // Both tool rows must be back-to-back, sidecar strictly after them.
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(out[2]).toMatchObject({ role: "tool", toolCallId: "tc-1", content: "screenshot taken" });
    expect(out[3]).toMatchObject({ role: "tool", toolCallId: "tc-2", content: "file contents" });
    const sidecar = out[4] as { role: string; images?: Array<{ url: string }> };
    expect(sidecar.images).toHaveLength(1);
    expect(sidecar.images?.[0].url).toBe(`data:${IMG.mime};base64,${IMG.b64}`);
  });

  it("emits one sidecar per image-bearing result, all after the tool batch, in order", () => {
    const messages: CanonicalMessage[] = [
      msg(
        "tool_result",
        { toolCallId: "tc-1", result: { text: "shot A", images: [IMG] } },
        "m1",
      ),
      msg("tool_result", { toolCallId: "tc-2", result: "plain" }, "m2"),
      msg(
        "tool_result",
        { toolCallId: "tc-3", result: { text: "shot B", images: [IMG, IMG] } },
        "m3",
      ),
    ];

    const out = canonicalToTransport(messages, undefined);
    expect(out.map((m) => m.role)).toEqual(["tool", "tool", "tool", "user", "user"]);
    expect((out[3] as { images?: unknown[] }).images).toHaveLength(1);
    expect((out[4] as { images?: unknown[] }).images).toHaveLength(2);
  });

  it("flushes the sidecar before a following non-tool row (single tool call, unchanged behavior)", () => {
    const messages: CanonicalMessage[] = [
      msg(
        "tool_result",
        { toolCallId: "tc-1", result: { text: "screenshot", images: [IMG] } },
        "m1",
      ),
      msg("assistant", { text: "analyzed the image" }, "m2"),
    ];

    const out = canonicalToTransport(messages, undefined);
    // Sidecar still precedes the next assistant turn so the model saw the
    // images on the turn that produced that reply.
    expect(out.map((m) => m.role)).toEqual(["tool", "user", "assistant"]);
  });

  it("folds the pendingRedirect into the flushed trailing sidecar (one user row, images kept)", () => {
    const messages: CanonicalMessage[] = [
      msg(
        "tool_result",
        { toolCallId: "tc-1", result: { text: "screenshot", images: [IMG] } },
        "m1",
      ),
    ];

    const out = canonicalToTransport(messages, {
      instructionId: "ri-1",
      text: "do something else",
      receivedAt: "2026-07-02T00:00:00Z",
    });
    // The sidecar still flushes before the redirect text, but they share ONE
    // user row: no user/user run for codex-style transports, and the volatile
    // wire tail stays the single row TurnInput.ephemeralTailMessages promises.
    expect(out.map((m) => m.role)).toEqual(["tool", "user"]);
    expect((out[1] as { images?: unknown[] }).images).toHaveLength(1);
    expect(out[1].content).toContain("Tool returned 1 image");
    expect(out[1].content).toContain("[REDIRECT]");
  });

  it("appends the redirect as its own row when the tail is not a user row", () => {
    const out = canonicalToTransport(
      [msg("assistant", { text: "done" }, "m1")],
      { instructionId: "ri-2", text: "change course", receivedAt: "2026-07-02T00:00:00Z" },
    );
    expect(out.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(out[1].content).toBe("[REDIRECT] change course");
  });
});
