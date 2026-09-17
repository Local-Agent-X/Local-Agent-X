// Almost-JSON from a local model parses after one bounded repair pass.
import { describe, expect, it } from "vitest";
import { repairJsonCandidates } from "./repair-json.js";

const parses = (raw: string) => {
  for (const candidate of repairJsonCandidates(raw)) {
    try { return JSON.parse(candidate) as unknown; } catch { /* try the next */ }
  }
  throw new Error(`no candidate parsed: ${JSON.stringify(repairJsonCandidates(raw))}`);
};

describe("repairJsonCandidates", () => {
  it("escapes a raw newline inside a string", () => {
    expect(parses('{"reason":"line one\nline two"}')).toEqual({ reason: "line one\nline two" });
  });

  it("drops a trailing comma", () => {
    expect(parses('{"unmet":["a","b",]}')).toEqual({ unmet: ["a", "b"] });
  });

  it("replaces smart quotes and Python literals", () => {
    expect(parses('{\u201cok\u201d:True,"extra":None}')).toEqual({ ok: true, extra: null });
  });

  it("leaves valid JSON alone (nothing to try)", () => {
    expect(repairJsonCandidates('{"ok":true}')).toEqual([]);
  });

  it("never rescues genuinely broken JSON", () => {
    expect(() => parses('{"ok": ')).toThrow();
  });

  it("fixes over-escaped quotes around quoted code, the spec-audit case", () => {
    // muse's spec audit named the unmet requirements and wrote \\" where JSON
    // wants \" , so the verdict was discarded twice (2026-09-17).
    const raw = '{"unmet":["\\\\"raise ValueError(x)\\\\" — code raises a generic message"],"met":[]}';
    expect(parses(raw)).toEqual({ unmet: ['"raise ValueError(x)" — code raises a generic message'], met: [] });
  });

  it("leaves a legal doubled backslash alone — valid JSON never reaches the repair", () => {
    const raw = '{"path":"C:\\\\"}';
    expect(JSON.parse(raw)).toEqual({ path: "C:\\" });
    // And if some other error sent it here, the repair keeps it parseable.
    expect(parses('{"path":"C:\\\\", }')).toEqual({ path: "C:\\" });
  });
});
