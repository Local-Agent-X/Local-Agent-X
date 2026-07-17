/**
 * parseArgs repair-ladder tests. Structured tool calls from local models
 * routinely arrive with near-miss JSON arguments. COSMETIC damage
 * (trailing comma, raw control chars) means the payload was complete and
 * is repaired; STRUCTURAL damage (unclosed braces/strings) means the
 * payload was truncated mid-write — finish_reason=length and kin — and
 * must keep the legacy `{_raw}` wrapping so the failure stays loud and
 * no partial write/command ever executes.
 */

import { describe, it, expect } from "vitest";
import { parseArgs, extractText, byteLengthUtf8 } from "./helpers.js";

describe("parseArgs — strict path (unchanged behavior)", () => {
  it("parses valid JSON objects", () => {
    expect(parseArgs('{"path":"a.txt"}')).toEqual({ path: "a.txt" });
  });

  it("returns {} for empty input", () => {
    expect(parseArgs("")).toEqual({});
  });

  it("still returns strictly-valid non-objects as-is", () => {
    expect(parseArgs("5")).toBe(5);
    expect(parseArgs('"str"')).toBe("str");
  });
});

describe("parseArgs — cosmetic repairs", () => {
  it("repairs a trailing comma (complete payload, sloppy tail)", () => {
    expect(parseArgs('{"path": "a.txt",}')).toEqual({ path: "a.txt" });
  });

  it("escapes raw control characters inside strings", () => {
    expect(parseArgs('{"cmd": "line1\nline2"}')).toEqual({ cmd: "line1\nline2" });
  });
});

describe("parseArgs — structural damage stays {_raw} (truncated calls must not execute)", () => {
  it("a truncated brace is NOT completed", () => {
    const raw = '{"path": "a.txt"';
    expect(parseArgs(raw)).toEqual({ _raw: raw });
  });

  it("nested truncation across braces and brackets is NOT completed", () => {
    const raw = '{"a": {"b": [1, 2';
    expect(parseArgs(raw)).toEqual({ _raw: raw });
  });

  it("a truncated string value is NOT completed (partial command hazard)", () => {
    const raw = '{"command": "rm -rf /tmp/build && echo done';
    expect(parseArgs(raw)).toEqual({ _raw: raw });
  });

  it("skeptic cloud repro: output-budget-truncated write args stay {_raw}", () => {
    const raw = '{"path":"config.json","content":"{\\"port\\":80';
    expect(parseArgs(raw)).toEqual({ _raw: raw });
  });
});

describe("parseArgs — other rejections", () => {
  it("keeps {_raw} for unrepairable input (bare keys are never guessed)", () => {
    const raw = '{action: "click"}';
    expect(parseArgs(raw)).toEqual({ _raw: raw });
  });

  it("rejects cosmetically-repaired non-objects with {_raw} (arrays stay rejected)", () => {
    const raw = "[1, 2,]";
    expect(parseArgs(raw)).toEqual({ _raw: raw });
  });

  it("skips the ladder for over-cap payloads", () => {
    const raw = '{"a": "' + "x".repeat(270_000);
    expect(parseArgs(raw)).toEqual({ _raw: raw });
  });
});

describe("existing helpers stay intact", () => {
  it("extractText probes string and {text} shapes", () => {
    expect(extractText("hi")).toBe("hi");
    expect(extractText({ text: "yo" })).toBe("yo");
    expect(extractText(null)).toBe("");
  });

  it("byteLengthUtf8 counts multi-byte characters", () => {
    expect(byteLengthUtf8("abc")).toBe(3);
    expect(byteLengthUtf8("é")).toBe(2);
  });
});
