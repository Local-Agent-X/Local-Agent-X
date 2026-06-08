import { describe, it, expect } from "vitest";
import { scanForSecrets, redactSecrets } from "./secret-scanner.js";

// Assemble a real-shaped Anthropic key at runtime from fragments so CI's own
// secret scanner doesn't flag this test's diff. Never write the literal.
const ANT_KEY = "sk-" + "ant-" + "api03" + "A".repeat(24);

describe("scanForSecrets — raw detection (unchanged behavior)", () => {
  it("detects a raw API key with a correct span", () => {
    const text = `here is a key ${ANT_KEY} in prose`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    const m = r.matches[0];
    expect(text.slice(m.startIndex, m.endIndex)).toContain(ANT_KEY);
    expect(redactSecrets(text)).not.toContain(ANT_KEY);
  });

  it("stays clean on ordinary prose", () => {
    expect(scanForSecrets("the quick brown fox jumps over the lazy dog").clean).toBe(true);
  });
});

describe("scanForSecrets — encoded-view detection", () => {
  it("catches a base64-encoded key and redacts the blob", () => {
    const blob = Buffer.from(ANT_KEY, "utf8").toString("base64");
    const text = `payload=${blob}`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    expect(r.matches.some(m => m.pattern.includes("(base64)"))).toBe(true);
    const out = redactSecrets(text);
    expect(out).not.toContain(blob);
  });

  it("catches a base64url-encoded key", () => {
    const blob = Buffer.from(ANT_KEY, "utf8").toString("base64url");
    const r = scanForSecrets(`x=${blob}`);
    expect(r.clean).toBe(false);
  });

  it("catches a hex-encoded key and redacts the blob", () => {
    const blob = Buffer.from(ANT_KEY, "utf8").toString("hex");
    const text = `data ${blob} end`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    expect(redactSecrets(text)).not.toContain(blob);
  });

  it("catches a percent/URL-encoded key", () => {
    const blob = encodeURIComponent(`token=${ANT_KEY}`);
    const r = scanForSecrets(`q=${blob}`);
    expect(r.clean).toBe(false);
  });

  it("catches a double-base64-encoded key", () => {
    const once = Buffer.from(ANT_KEY, "utf8").toString("base64");
    const twice = Buffer.from(once, "utf8").toString("base64");
    expect(scanForSecrets(`v=${twice}`).clean).toBe(false);
  });
});

describe("scanForSecrets — unicode-obfuscated detection", () => {
  it("catches a zero-width-injected key and the span covers real bytes", () => {
    const zwsp = "​";
    const obf = "sk-" + "a" + zwsp + "nt-" + "api03" + "A".repeat(24);
    const text = `key: ${obf}`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    const m = r.matches[0];
    expect(m.startIndex).toBeGreaterThanOrEqual(0);
    expect(m.endIndex).toBeLessThanOrEqual(text.length);
    expect(redactSecrets(text)).not.toContain(obf);
  });

  it("catches a fullwidth-homoglyph-obfuscated key (NFKC fold)", () => {
    // Fullwidth latin 's' and 'k' fold to ASCII under NFKC.
    const obf = "ｓｋ-" + "ant-" + "api03" + "A".repeat(24);
    const r = scanForSecrets(`creds ${obf}`);
    expect(r.clean).toBe(false);
  });
});

describe("scanForSecrets — negatives (no new false positives)", () => {
  it("base64 of a non-secret stays clean", () => {
    const blob = Buffer.from("hello world, this is fine", "utf8").toString("base64");
    expect(scanForSecrets(`note=${blob}`).clean).toBe(true);
  });

  it("a UUID stays clean", () => {
    expect(scanForSecrets("id 550e8400-e29b-41d4-a716-446655440000").clean).toBe(true);
  });

  it("a git SHA stays clean", () => {
    expect(scanForSecrets("commit 77e59a44a1b2c3d4e5f60718293a4b5c6d7e8f90").clean).toBe(true);
  });

  it("ordinary prose with no encoded runs stays clean", () => {
    expect(scanForSecrets("Meet me at 3pm to review the design doc, thanks.").clean).toBe(true);
  });
});
