import { describe, expect, it } from "vitest";

import {
  chatEvidence,
  qualificationPrompt,
  READ_NONCE,
} from "../scripts/local-qualification/chat-evidence.js";

interface ReadEventsOptions {
  path?: string;
  result?: string;
  assistant?: string;
}

function readEvents(options: ReadEventsOptions = {}): Array<Record<string, unknown>> {
  return [
    {
      type: "tool_start",
      toolName: "read",
      toolCallId: "read-1",
      args: { path: options.path ?? "workspace/qualification-note.txt" },
    },
    {
      type: "tool_end",
      toolName: "read",
      toolCallId: "read-1",
      allowed: true,
      status: "ok",
      result: options.result ?? `1\t${READ_NONCE}\n2\t`,
    },
    { type: "stream", delta: options.assistant ?? READ_NONCE },
    { type: "done" },
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
    events.unshift({ type: "stream", delta: READ_NONCE });
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
});
