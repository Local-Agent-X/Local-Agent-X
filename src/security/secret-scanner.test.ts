import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
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

// ── Catalog shapes migrated from the old supplemental sets ───────────────────
// These now live in CREDENTIAL_PATTERNS, so scanForSecrets (which backs the http
// egress guard) catches them — egress of a model-emitted body carrying one of
// these is now blocked, which the old local-only supplemental sets never did.
describe("scanForSecrets — migrated catalog shapes (now gate egress)", () => {
  it("detects a Google API key (AIza…)", () => {
    const r = scanForSecrets("key " + "AIza" + "a".repeat(35));
    expect(r.clean).toBe(false);
    expect(r.matches.some(m => m.pattern === "Google API Key")).toBe(true);
  });

  it("detects an OpenAI scoped key (sk-proj-)", () => {
    const r = scanForSecrets("sk-proj-" + "Ab12".repeat(8));
    expect(r.clean).toBe(false);
    expect(r.matches.some(m => m.pattern === "OpenAI Scoped Key")).toBe(true);
  });

  it("detects a JWT and redacts it", () => {
    const seg = "a".repeat(20);
    const jwt = `eyJ${seg}.eyJ${seg}.${seg}`;
    const r = scanForSecrets(`auth=${jwt}`);
    expect(r.clean).toBe(false);
    expect(r.matches.some(m => m.pattern === "JWT")).toBe(true);
    expect(redactSecrets(`auth=${jwt}`)).not.toContain(jwt);
  });

  it("detects a bare PEM BEGIN marker (no matching END)", () => {
    const r = scanForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\n(truncated)");
    expect(r.clean).toBe(false);
    expect(r.matches.some(m => m.pattern === "Private Key Marker (PEM)")).toBe(true);
  });
});

// ── Shannon-entropy detector for UNKNOWN (unprefixed) secrets ────────────────
describe("scanForSecrets — high-entropy detector (positives)", () => {
  // base64url alphabet, no `=` padding, no `-`/`_` runs that would read as a
  // slug. Assembled at runtime so CI's own scanner doesn't flag the diff.
  function randomBase64ish(byteLen: number): string {
    return randomBytes(byteLen).toString("base64").replace(/[+/=]/g, "x");
  }

  // Surround with NEUTRAL prose (no `token`/`key`/`secret` keyword) so the only
  // thing that can flag the run is the entropy pass itself, not a keyword shape.
  it("flags a random 40-char base64-ish token", () => {
    const token = randomBase64ish(30).slice(0, 40);
    const text = `the value is ${token} as returned`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    expect(r.matches.some(m => m.type === "high-entropy-token")).toBe(true);
    expect(redactSecrets(text)).not.toContain(token);
  });

  it("flags a random 48-char base64-ish token", () => {
    const token = randomBase64ish(36).slice(0, 48);
    const text = `received ${token} from upstream`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    expect(r.matches.some(m => m.type === "high-entropy-token")).toBe(true);
    expect(redactSecrets(text)).not.toContain(token);
  });
});

describe("scanForSecrets — high-entropy detector (false-positive traps stay clean)", () => {
  // Each of these is a benign high-entropy-LOOKING shape. A false positive here
  // blocks a legitimate egress, so they MUST stay clean.
  const benign: Array<[string, string]> = [
    ["a UUID", "request id 550e8400-e29b-41d4-a716-446655440000 received"],
    ["a git SHA-1 (40 hex)", "commit 77e59a44a1b2c3d4e5f60718293a4b5c6d7e8f90 landed"],
    ["a SHA-256 (64 hex)", "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["an MD5 (32 hex)", "md5 d41d8cd98f00b204e9800998ecf8427e"],
    ["an English sentence", "The committee will reconvene on Thursday afternoon to finalize the budget."],
    ["a long file path", "/Users/dev/Projects/local-agent-x/src/security/credential-patterns.ts"],
    ["a CSS class soup", "<div class=\"flex items-center justify-between gap-4 rounded-lg bg-slate-50\">"],
    ["a minified-code snippet", "function(a,b){return a.concat(b).filter(Boolean).map(function(x){return x*2})}"],
    ["base64 of ordinary prose", "note=" + Buffer.from("the meeting notes are attached for your review please read", "utf8").toString("base64")],
  ];

  for (const [label, text] of benign) {
    it(`stays clean: ${label}`, () => {
      expect(scanForSecrets(text).clean).toBe(true);
    });
  }
});
