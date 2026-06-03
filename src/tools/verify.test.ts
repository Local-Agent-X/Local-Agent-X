import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { verifyWriteLanded } from "./verify.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "verify-test-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("verifyWriteLanded — happy path", () => {
  it("returns ok for a file that exists with no opts", () => {
    const p = join(tmpRoot, "exists.txt");
    writeFileSync(p, "hello", "utf8");
    expect(verifyWriteLanded(p)).toEqual({ ok: true });
  });
});

describe("verifyWriteLanded — missing file", () => {
  it("returns not-found reason when path does not exist", () => {
    const r = verifyWriteLanded(join(tmpRoot, "nonexistent-xyz.txt"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found/);
  });
});

describe("verifyWriteLanded — minBytes", () => {
  it("rejects when file is smaller than minBytes and reports byte count", () => {
    const p = join(tmpRoot, "small.txt");
    writeFileSync(p, "x".repeat(10), "utf8");
    const r = verifyWriteLanded(p, { minBytes: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/too small/);
      expect(r.reason).toMatch(/10 bytes/);
    }
  });

  it("passes when file meets minBytes", () => {
    const p = join(tmpRoot, "big.txt");
    writeFileSync(p, "y".repeat(200), "utf8");
    expect(verifyWriteLanded(p, { minBytes: 100 })).toEqual({ ok: true });
  });
});

describe("verifyWriteLanded — mustContain", () => {
  it("passes when content contains the substring", () => {
    const p = join(tmpRoot, "html-ok.html");
    writeFileSync(p, "<html><body>hi</body></html>", "utf8");
    expect(verifyWriteLanded(p, { mustContain: "<body>" })).toEqual({ ok: true });
  });

  it("rejects when content does not contain the substring", () => {
    const p = join(tmpRoot, "html-missing.html");
    writeFileSync(p, "no html here", "utf8");
    const r = verifyWriteLanded(p, { mustContain: "<body>" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/missing expected content/);
      expect(r.reason).toMatch(/body/);
    }
  });
});

describe("verifyWriteLanded — combined opts evaluation order", () => {
  it("reports minBytes failure before mustContain runs", () => {
    const p = join(tmpRoot, "tiny-match.txt");
    writeFileSync(p, "<body>", "utf8"); // 6 bytes, contains the substring
    const r = verifyWriteLanded(p, { minBytes: 100, mustContain: "<body>" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/too small/);
      expect(r.reason).not.toMatch(/missing expected content/);
    }
  });
});

describe("verifyWriteLanded — mustContain on missing file", () => {
  it("returns not-found reason (stat fails before read)", () => {
    const r = verifyWriteLanded(join(tmpRoot, "nope.txt"), { mustContain: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found/);
  });
});
