import { describe, expect, it } from "vitest";
import { failureReason, failureSignature, MAX_FAILURE_REASON_CHARS } from "./failure-signature.js";
import { err, renderToolResultForModel } from "./result-helpers.js";

const base = { tool: "edit", status: "error", reason: "old_string found 2 times in C:\\w\\a.ts" };

describe("failureSignature", () => {
  it("is the same for one failure met through different files and counts", () => {
    const other = { ...base, reason: "old_string found 7 times in C:\\elsewhere\\b.ts" };
    expect(failureSignature(other)).toBe(failureSignature(base));
  });

  it("differs by tool, action, status and the gate that refused", () => {
    const sigs = new Set([
      failureSignature(base),
      failureSignature({ ...base, tool: "multi_edit" }),
      failureSignature({ ...base, action: "replace" }),
      failureSignature({ ...base, status: "timeout" }),
      failureSignature({ ...base, status: "blocked", layer: "security" }),
      failureSignature({ ...base, status: "blocked", layer: "tool-policy" }),
    ]);
    expect(sigs.size).toBe(6);
  });

  it("differs when the gate's own sentence differs", () => {
    expect(failureSignature({ ...base, reason: "file has changed since it was read" })).not.toBe(failureSignature(base));
  });

  it("is short enough for a URL and a JSON key", () => {
    expect(failureSignature(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("failureReason", () => {
  it("is the first line that says anything", () => {
    expect(failureReason("\n\n  python3: command not found  \nmore")).toBe("python3: command not found");
  });

  it("is not the status header of a rendered result", () => {
    const rendered = renderToolResultForModel(err("exit 127: python3 not found", { exit_code: 127 }));
    expect(failureReason(rendered)).toBe("exit 127: python3 not found");
  });

  it("is capped", () => {
    expect(failureReason("x".repeat(900))).toHaveLength(MAX_FAILURE_REASON_CHARS);
  });

  it("is empty for an empty result", () => {
    expect(failureReason("")).toBe("");
  });
});
