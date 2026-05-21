import { describe, it, expect } from "vitest";
import {
  previewFileEdit,
  previewShellCommand,
  previewNetworkWrite,
  previewMoney,
} from "./approval-manager.js";

describe("previewFileEdit", () => {
  it("counts added and removed lines", () => {
    const oldC = "alpha\nbeta\ngamma\n";
    const newC = "alpha\nBETA\ngamma\ndelta\n";
    const p = previewFileEdit("src/x.ts", oldC, newC);
    expect(p.kind).toBe("file");
    expect(p.path).toBe("src/x.ts");
    expect(p.lineCount.added).toBe(2);
    expect(p.lineCount.removed).toBe(1);
    expect(p.truncated).toBe(false);
    expect(p.diff).toContain("-beta");
    expect(p.diff).toContain("+BETA");
    expect(p.diff).toContain("+delta");
  });

  it("returns a clean structure when no changes", () => {
    const same = "line1\nline2\n";
    const p = previewFileEdit("src/x.ts", same, same);
    expect(p.lineCount).toEqual({ added: 0, removed: 0 });
    expect(p.truncated).toBe(false);
  });

  it("truncates long diffs to head + tail with elision marker", () => {
    const oldC = Array.from({ length: 100 }, (_, i) => `old-line-${i}`).join("\n");
    const newC = Array.from({ length: 100 }, (_, i) => `new-line-${i}`).join("\n");
    const p = previewFileEdit("src/big.ts", oldC, newC);
    expect(p.truncated).toBe(true);
    expect(p.diff).toMatch(/… \d+ lines? elided …/);
    expect(p.diff).toContain("old-line-0");
    expect(p.diff).toContain("new-line-99");
  });

  it("does not truncate diffs at or below the 20-line threshold", () => {
    const oldC = "a\nb\nc\n";
    const newC = "a\nB\nc\n";
    const p = previewFileEdit("src/small.ts", oldC, newC);
    expect(p.truncated).toBe(false);
    expect(p.diff).not.toMatch(/elided/);
  });

  it("tolerates malformed inputs without throwing", () => {
    // @ts-expect-error — exercising runtime fallback
    const a = previewFileEdit(undefined, undefined, undefined);
    expect(a.kind).toBe("file");
    expect(a.path).toBe("<unknown>");
    expect(a.lineCount).toEqual({ added: 0, removed: 0 });

    // @ts-expect-error
    const b = previewFileEdit("p", null, null);
    expect(b.lineCount).toEqual({ added: 0, removed: 0 });
  });

  it("does not count diff metadata lines (+++ / ---) as content changes", () => {
    const p = previewFileEdit("src/x.ts", "a\n", "b\n");
    expect(p.lineCount.added).toBe(1);
    expect(p.lineCount.removed).toBe(1);
  });
});

describe("previewShellCommand", () => {
  it("returns cmd and cwd", () => {
    const p = previewShellCommand("ls -la", "/tmp");
    expect(p).toEqual({ kind: "shell", cmd: "ls -la", cwd: "/tmp" });
  });

  it("includes explanation when provided", () => {
    const p = previewShellCommand("rm -rf foo", "/x", "deletes the foo directory");
    expect(p.explanation).toBe("deletes the foo directory");
  });

  it("omits explanation when empty", () => {
    const p = previewShellCommand("ls", "/", "");
    expect("explanation" in p).toBe(false);
  });

  it("coerces malformed inputs to empty strings", () => {
    // @ts-expect-error
    const p = previewShellCommand(undefined, undefined);
    expect(p.cmd).toBe("");
    expect(p.cwd).toBe("");
  });
});

describe("previewNetworkWrite", () => {
  it("extracts domain from absolute URL", () => {
    const p = previewNetworkWrite("POST", "https://api.example.com/v1/users", { a: 1 });
    expect(p.method).toBe("POST");
    expect(p.domain).toBe("api.example.com");
    expect(p.url).toBe("https://api.example.com/v1/users");
    expect(p.bodyPreview).toBe('{"a":1}');
    expect(p.bodyTruncated).toBe(false);
  });

  it("uppercases the method", () => {
    const p = previewNetworkWrite("delete", "https://x.com/", null);
    expect(p.method).toBe("DELETE");
  });

  it("truncates body previews longer than 500 chars", () => {
    const big = "x".repeat(1000);
    const p = previewNetworkWrite("POST", "https://x.com/", big);
    expect(p.bodyTruncated).toBe(true);
    expect(p.bodyPreview.length).toBe(501);
    expect(p.bodyPreview.endsWith("…")).toBe(true);
  });

  it("handles null and undefined body", () => {
    expect(previewNetworkWrite("GET", "https://x.com/", null).bodyPreview).toBe("");
    expect(previewNetworkWrite("GET", "https://x.com/", undefined).bodyPreview).toBe("");
  });

  it("falls back gracefully for malformed URLs", () => {
    // No scheme, no path separators → regex captures the whole string;
    // good enough for the UI to render something instead of crashing.
    const p = previewNetworkWrite("POST", "not a url", {});
    expect(p.domain).toBe("not a url");
    expect(typeof p.domain).toBe("string");
  });

  it("strips path from schemeless URL when extracting domain", () => {
    const p = previewNetworkWrite("POST", "example.com/foo/bar", {});
    expect(p.domain).toBe("example.com");
  });

  it("extracts host from schemeless URL", () => {
    const p = previewNetworkWrite("GET", "api.example.com/path", null);
    expect(p.domain).toBe("api.example.com");
  });

  it("defaults missing method to GET", () => {
    // @ts-expect-error
    const p = previewNetworkWrite(undefined, "https://x.com/", null);
    expect(p.method).toBe("GET");
  });

  it("stringifies non-JSON-serializable bodies via String()", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const p = previewNetworkWrite("POST", "https://x.com/", circular);
    expect(typeof p.bodyPreview).toBe("string");
    expect(p.bodyPreview.length).toBeGreaterThan(0);
  });
});

describe("previewMoney", () => {
  it("formats USD amounts with the dollar sign", () => {
    const p = previewMoney(49.5, "USD", "acct_123", "stripe");
    expect(p.kind).toBe("money");
    expect(p.amount).toBe(49.5);
    expect(p.currency).toBe("USD");
    expect(p.recipient).toBe("acct_123");
    expect(p.source).toBe("stripe");
    expect(p.formatted).toMatch(/\$49\.50/);
  });

  it("uppercases the currency code", () => {
    const p = previewMoney(10, "eur", "x", "y");
    expect(p.currency).toBe("EUR");
  });

  it("falls back gracefully on unknown currency", () => {
    const p = previewMoney(10, "ZZZ", "x", "y");
    expect(typeof p.formatted).toBe("string");
    expect(p.formatted.length).toBeGreaterThan(0);
  });

  it("coerces malformed inputs", () => {
    // @ts-expect-error
    const p = previewMoney(NaN, undefined, undefined, undefined);
    expect(p.amount).toBe(0);
    expect(p.currency).toBe("USD");
    expect(p.recipient).toBe("");
    expect(p.source).toBe("");
  });

  it("handles negative amounts (refunds)", () => {
    const p = previewMoney(-25, "USD", "user@x.com", "stripe");
    expect(p.amount).toBe(-25);
    expect(p.formatted).toContain("25");
  });
});
