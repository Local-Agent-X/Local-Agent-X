// Regression: UTF-8 chunk-boundary corruption in the CLI stdout parsers.
// `chunk.toString()` decodes each pipe Buffer independently, so a multibyte
// char (emoji/CJK) split across chunks became U+FFFD on both sides. Both CLI
// paths (cold-spawn + warm-pool) must decode with a streaming TextDecoder,
// like the API path in stream-api.ts already does.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { StreamEvent } from "./types.js";

const spawnMock = vi.fn();
// stream-cli.ts imports "child_process"; warm-pool/spawn.ts imports
// "node:child_process" — mock both specifiers onto the same fake.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});
// Cold-spawn probes runtime config for MCP wiring; there is none in tests.
vi.mock("../config.js", () => ({
  getRuntimeConfig: () => { throw new Error("no runtime config in test"); },
}));

const TEXT = "héllo 🚀 wörld";

/** JSON line for the frame, split MID-EMOJI into two byte chunks. */
function splitMidEmoji(frame: Record<string, unknown>): [Buffer, Buffer] {
  const bytes = Buffer.from(JSON.stringify(frame) + "\n", "utf8");
  const emojiAt = bytes.indexOf(Buffer.from("🚀", "utf8"));
  expect(emojiAt).toBeGreaterThan(-1);
  // 🚀 is 4 bytes (F0 9F 9A 80); cut after the 2nd.
  return [Buffer.from(bytes.subarray(0, emojiAt + 2)), Buffer.from(bytes.subarray(emojiAt + 2))];
}

const deltaFrame = {
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: TEXT } },
};

beforeEach(() => {
  spawnMock.mockReset();
});

describe("cold-spawn CLI parser — multibyte char split across stdout chunks", () => {
  it("reassembles a mid-emoji chunk boundary instead of emitting U+FFFD", async () => {
    process.env.LAX_CLAUDE_WARM_POOL = "0"; // force the cold-spawn path
    const [head, tail] = splitMidEmoji(deltaFrame);
    const resultLine = Buffer.from(JSON.stringify({ type: "result", result: TEXT, usage: {} }) + "\n", "utf8");

    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    proc.stdout = Readable.from([head, Buffer.concat([tail, resultLine])]);
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    spawnMock.mockReturnValueOnce(proc);

    const { streamViaCliWithTools } = await import("./stream-cli.js");
    const events: StreamEvent[] = [];
    for await (const ev of streamViaCliWithTools({
      token: "",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "",
    })) {
      events.push(ev);
    }

    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.delta ?? "")
      .join("");
    expect(text).toBe(TEXT);
    expect(text).not.toContain("�");
  });
});

describe("warm-pool spawn parser — multibyte char split across stdout chunks", () => {
  it("delivers the frame to the active listener with the emoji intact", async () => {
    const stdout = new EventEmitter();
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    proc.stdout = stdout;
    proc.stderr = new EventEmitter();
    spawnMock.mockReturnValueOnce(proc);

    const { spawnWarmProcess } = await import("./warm-pool/spawn.js");
    const wp = spawnWarmProcess({ model: "claude-test", permissionMode: "plan" }, { onExit: () => {} });

    const frames: Array<Record<string, unknown>> = [];
    wp.activeListener = (frame) => frames.push(frame as Record<string, unknown>);

    const [head, tail] = splitMidEmoji(deltaFrame);
    stdout.emit("data", head);
    stdout.emit("data", tail);

    expect(frames).toHaveLength(1);
    const delta = (frames[0].event as { delta: { text: string } }).delta;
    expect(delta.text).toBe(TEXT);
    expect(delta.text).not.toContain("�");
  });
});
