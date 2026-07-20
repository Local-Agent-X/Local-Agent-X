import { describe, expect, it } from "vitest";

import {
  chatEvidence,
  qualificationPrompt,
  READ_NONCE,
  readSse,
} from "../scripts/local-qualification/chat-evidence.js";

interface ReadEventsOptions {
  path?: string;
  result?: string;
  assistant?: string;
}

function readEvents(options: ReadEventsOptions = {}): Array<Record<string, unknown>> {
  return [
    { type: "context_status", percentage: 0, level: "ok", usedTokens: 30, maxTokens: 32768, compacted: false },
    { type: "chat_op_started", opId: "op-read-1" },
    {
      type: "tool_start",
      toolName: "read",
      toolCallId: "read-1",
      args: { path: options.path ?? "workspace/qualification-note.txt", _sessionId: "qualification-test" },
      riskLevel: "low",
      context: "Read file: qualification-note.txt",
      requiresApproval: false,
    },
    {
      type: "tool_end",
      toolName: "read",
      toolCallId: "read-1",
      allowed: true,
      status: "ok",
      result: options.result ?? `1\t${READ_NONCE}\n2\t`,
      metadata: { path: "C:\\Temp\\qualification-note.txt", bytes: 28, total_lines: 2, lines_shown: 2 },
    },
    { type: "stream", delta: options.assistant ?? READ_NONCE },
    { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
  ];
}

describe("local qualification workspace-read evidence", () => {
  it("keeps the hidden file value out of the model prompt", () => {
    const prompt = qualificationPrompt("workspace-read");
    expect(prompt).toContain("workspace/qualification-note.txt");
    expect(prompt).not.toContain(READ_NONCE);
  });

  it("accepts only the exact matching read result followed by the same assistant value", () => {
    const evidence = chatEvidence(readEvents());
    expect(evidence.safeReadLifecycle).toBe(true);
    expect(evidence.readNonceSeen).toBe(true);
  });

  it("accepts one exact response split across streaming deltas", () => {
    const events = readEvents({ assistant: "" });
    events.splice(-2, 1,
      { type: "stream", delta: READ_NONCE.slice(0, 8) },
      { type: "stream", delta: READ_NONCE.slice(8, 21) },
      { type: "stream", delta: READ_NONCE.slice(21) },
    );
    expect(chatEvidence(events).readNonceSeen).toBe(true);
  });

  it("permits only surrounding response whitespace during normalization", () => {
    expect(chatEvidence(readEvents({ assistant: `\r\n  ${READ_NONCE}\t\n` })).readNonceSeen).toBe(true);
  });

  it.each([
    `prefix ${READ_NONCE}`,
    `${READ_NONCE} suffix`,
    `${READ_NONCE}${READ_NONCE}`,
    `${READ_NONCE}\nwrong text`,
  ])("rejects non-exact assistant continuation %j", (assistant) => {
    expect(chatEvidence(readEvents({ assistant })).readNonceSeen).toBe(false);
  });

  it("rejects multiple deltas when their concatenated response contains extra content", () => {
    const events = readEvents({ assistant: "" });
    events.splice(-2, 1,
      { type: "stream", delta: READ_NONCE },
      { type: "stream", delta: " extra" },
    );
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it.each(["1\tWRONG\n2\t", ""])(
    "rejects an allowed read result of %j even when the assistant guesses the hidden value",
    (result) => {
      const evidence = chatEvidence(readEvents({ result, assistant: READ_NONCE }));
      expect(evidence.safeReadLifecycle).toBe(false);
      expect(evidence.readNonceSeen).toBe(false);
    },
  );

  it("rejects the right-looking result from an unrelated read", () => {
    const evidence = chatEvidence(readEvents({ path: "workspace/unrelated.txt" }));
    expect(evidence.safeReadLifecycle).toBe(false);
    expect(evidence.readNonceSeen).toBe(false);
  });

  it("rejects a correct tool result when the assistant ignores it", () => {
    const evidence = chatEvidence(readEvents({ assistant: "I read the file." }));
    expect(evidence.safeReadLifecycle).toBe(true);
    expect(evidence.readNonceSeen).toBe(false);
  });

  it("rejects a pre-tool guess even when the post-tool response is correct", () => {
    const events = readEvents();
    events.splice(2, 0, { type: "stream", delta: READ_NONCE });
    const evidence = chatEvidence(events);
    expect(evidence.safeReadLifecycle).toBe(true);
    expect(evidence.readNonceSeen).toBe(false);
  });

  it("rejects multiple assistant answers", () => {
    const events = readEvents();
    events.push({ type: "stream", delta: READ_NONCE }, { type: "done" });
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it("rejects even an empty assistant stream after the terminal response", () => {
    const events = readEvents();
    events.push({ type: "stream", delta: "" });
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it("rejects a replacement-shaped second assistant answer", () => {
    const events = readEvents();
    events.splice(-1, 0, { type: "stream", replace: true, text: READ_NONCE });
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it("rejects a correct assistant answer backed by the wrong tool result", () => {
    const evidence = chatEvidence(readEvents({
      result: "1\tcontent from a different file\n2\t",
      assistant: READ_NONCE,
    }));
    expect(evidence.safeReadLifecycle).toBe(false);
    expect(evidence.readNonceSeen).toBe(false);
  });

  it.each([
    ["heartbeat after done", "after-done", { type: "op_heartbeat", opId: "op-read-1" }],
    ["error after done", "after-done", { type: "error", message: "late failure" }],
    ["metadata after done", "after-done", { type: "context_status", percentage: 1 }],
    ["reasoning before the read", "before-start", { type: "reasoning", delta: READ_NONCE }],
    ["metadata before the read", "before-start", { type: "context_status", percentage: 1 }],
  ] as const)("rejects %s", (_label, position, frame) => {
    const events = readEvents();
    insertFrame(events, position, frame);
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it.each([0, 1])("rejects content smuggled onto allowed prelude frame %i", (index) => {
    const events = readEvents();
    events[index] = { ...events[index], delta: READ_NONCE };
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it("rejects the nonce in context status level", () => {
    const events = readEvents();
    events[0] = { ...events[0], level: READ_NONCE };
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it("rejects the nonce in the chat operation id", () => {
    const events = readEvents();
    events[1] = { ...events[1], opId: READ_NONCE };
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it("rejects extra nested tool metadata", () => {
    const events = readEvents();
    events[3] = {
      ...events[3],
      metadata: { ...(events[3].metadata as Record<string, unknown>), content: READ_NONCE },
    };
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it.each([
    { type: "stream", delta: READ_NONCE, replace: true, text: READ_NONCE },
    { type: "stream", delta: READ_NONCE, metadata: { source: "unverified" } },
  ])("rejects non-append stream shape %#", (stream) => {
    const events = readEvents();
    events[4] = stream;
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it("rejects done carrying assistant content", () => {
    const events = readEvents();
    events[5] = { ...events[5], delta: READ_NONCE };
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it.each([0, 1, 2, 3, 4, 5])("rejects an extra own key on accepted frame %i", (index) => {
    const events = readEvents();
    events[index] = { ...events[index], extra: true };
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it.each([0, 1, 2, 3, 4, 5])("rejects an inherited field on accepted frame %i", (index) => {
    const events = readEvents();
    events[index] = Object.assign(Object.create({ inherited: READ_NONCE }), events[index]);
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it("rejects extra own keys in every accepted nested object", () => {
    for (const [frameIndex, field] of [[2, "args"], [3, "metadata"], [5, "usage"]] as const) {
      const events = readEvents();
      const nested = events[frameIndex][field] as Record<string, unknown>;
      events[frameIndex] = { ...events[frameIndex], [field]: { ...nested, extra: true } };
      expect(chatEvidence(events).readNonceSeen, `${frameIndex}.${field}`).toBe(false);
    }
  });

  it("rejects inherited fields in every accepted nested object", () => {
    for (const [frameIndex, field] of [[2, "args"], [3, "metadata"], [5, "usage"]] as const) {
      const events = readEvents();
      const nested = events[frameIndex][field] as Record<string, unknown>;
      const inherited = Object.assign(Object.create({ inherited: READ_NONCE }), nested);
      events[frameIndex] = { ...events[frameIndex], [field]: inherited };
      expect(chatEvidence(events).readNonceSeen, `${frameIndex}.${field}`).toBe(false);
    }
  });

  it("recursively rejects the nonce in an otherwise valid pre-result nested field", () => {
    const events = readEvents();
    const args = events[2].args as Record<string, unknown>;
    events[2] = { ...events[2], args: { ...args, _sessionId: READ_NONCE } };
    expect(chatEvidence(events).readNonceSeen).toBe(false);
  });

  it.each(["not-json", "42", '{"type":"unknown_qualification_event"}'])(
    "surfaces invalid SSE data after done: %s",
    async (payload) => {
      const body = `${readEvents().map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: ${payload}\n\n`;
      const evidence = chatEvidence(await readSse(new Response(body)));
      expect(evidence.errorEvents).toBe(1);
      expect(evidence.readNonceSeen).toBe(false);
    },
  );

  const invalidFrames = [
    { type: "op_heartbeat", opId: "op-read-1" },
    { type: "error", message: "failure" },
    { type: "context_status", percentage: 1 },
    { type: "reasoning", delta: "private reasoning" },
    { type: "tool_progress", toolName: "read", toolCallId: "read-1" },
    { type: "usage", totalTokens: 1 },
    { type: "stream", replace: true, text: READ_NONCE },
  ];

  it.each(["before-start", "between-start-end", "before-done", "after-done"] as const)(
    "rejects every non-grammar frame at %s",
    (position) => {
      for (const frame of invalidFrames) {
        const events = readEvents();
        insertFrame(events, position, frame);
        expect(chatEvidence(events).readNonceSeen, JSON.stringify({ position, frame })).toBe(false);
      }
    },
  );
});

function insertFrame(
  events: Array<Record<string, unknown>>,
  position: "before-start" | "between-start-end" | "before-done" | "after-done",
  frame: Record<string, unknown>,
): void {
  const index = {
    "before-start": 2,
    "between-start-end": 3,
    "before-done": events.length - 1,
    "after-done": events.length,
  }[position];
  events.splice(index, 0, frame);
}
