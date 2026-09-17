// Almost-JSON from a local model parses after one bounded repair pass.
import { describe, expect, it } from "vitest";
import { repairJsonText } from "./repair-json.js";

const parses = (raw: string) => {
  const repaired = repairJsonText(raw);
  expect(repaired, "expected a repair").not.toBeNull();
  return JSON.parse(repaired as string);
};

describe("repairJsonText", () => {
  it("escapes a raw newline inside a string", () => {
    expect(parses('{"reason":"line one\nline two"}')).toEqual({ reason: "line one\nline two" });
  });

  it("drops a trailing comma", () => {
    expect(parses('{"unmet":["a","b",]}')).toEqual({ unmet: ["a", "b"] });
  });

  it("replaces smart quotes and Python literals", () => {
    expect(parses('{“ok”:True,"extra":None}')).toEqual({ ok: true, extra: null });
  });

  it("leaves valid JSON alone (no repair reported)", () => {
    expect(repairJsonText('{"ok":true}')).toBeNull();
  });

  it("never rescues genuinely broken JSON", () => {
    const repaired = repairJsonText('{"ok": ') ?? '{"ok": ';
    expect(() => JSON.parse(repaired)).toThrow();
  });
});
