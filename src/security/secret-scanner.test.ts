import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { scanForSecrets, redactSecrets } from "./secret-scanner.js";
import {
  registerRedactedSecretValue,
  unregisterRedactedSecretValue,
} from "./known-secrets.js";

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

describe("scanForSecrets — encoding-evasion regressions (H7/H8)", () => {
  // H7: a key carried as base64 of UTF-16LE bytes. The receiver recovers it via
  // `.toString('utf16le')`; the latin1 decode renders it NUL-interleaved so the
  // catalog regex (needs contiguous chars) and the known-value substring check
  // both miss it, and a low-entropy ASCII prefix drops the encoded blob below the
  // entropy floor — the DECODE path's new utf16le view is what must catch it.
  //
  // No-prefix variant: the decoded utf16le view is `sk-ant-…` at string start, so
  // the catalog's `\b(sk-ant-…)` fires directly.
  it("H7: catches a utf16le-base64 sk-ant key with no prefix (catalog)", () => {
    const blob = Buffer.from(ANT_KEY, "utf16le").toString("base64");
    const r = scanForSecrets(`payload=${blob}`);
    expect(r.clean).toBe(false);
  });

  // Prefixed variant: 40 ASCII chars sit directly before `sk-ant`, so the RAW
  // catalog's `\b` boundary can't fire. Originally only the known-value pass over
  // the utf16le view caught it; after the C3-19 anchor-relaxation the DERIVED-view
  // catalog (firstMatchNameDerived, leading `\b` stripped) also recovers it
  // directly. Either pass making the scan NOT clean is the security property —
  // dedup by span may keep only one match, so assert NOT clean and that SOME pass
  // (known-value or the obfuscated catalog) covers the encoded blob.
  it("H7: catches a utf16le-base64 key behind a low-entropy prefix (derived view)", () => {
    const blob = Buffer.from("A".repeat(40) + ANT_KEY, "utf16le").toString("base64");
    registerRedactedSecretValue(ANT_KEY);
    try {
      const r = scanForSecrets(`payload=${blob}`);
      expect(r.clean).toBe(false);
      expect(
        r.matches.some(
          (m) => m.type === "known-secret-value" || m.type === "obfuscated"
        )
      ).toBe(true);
    } finally {
      unregisterRedactedSecretValue(ANT_KEY);
    }
  });

  // H8: combining acute (U+0301) after every character. NFKC alone leaves the
  // letter+mark pairs intact; the scanner view must NFKD-decompose and strip the
  // U+0300–U+036F block so the bare run re-forms.
  it("H8: catches a key with a combining mark after each character", () => {
    const interleaved = [...ANT_KEY].map((c) => c + "́").join("");
    const r = scanForSecrets(`key: ${interleaved}`);
    expect(r.clean).toBe(false);
  });
});

describe("scanForSecrets — negatives (no new false positives)", () => {
  it("legitimate accented prose stays clean (NFKD strip is detection-only)", () => {
    expect(scanForSecrets("café résumé naïve coöperate").clean).toBe(true);
  });

  it("a normal plaintext sk-ant key still detects after the NFKD change", () => {
    expect(scanForSecrets(`token ${ANT_KEY} here`).clean).toBe(false);
  });

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

describe("scanForSecrets — round-3 encoding/normalization evasions (C3-6..19)", () => {
  // C3-7: hex of UTF-16LE bytes. Like the base64 H7 case, the latin1 decode is
  // NUL-interleaved; hex must also surface both-endian utf16le views so the key
  // re-forms contiguously and the (derived) catalog fires.
  it("C3-7: catches hex(utf16le(key)) — was clean before the hex multi-view fix", () => {
    const blob = Buffer.from(ANT_KEY, "utf16le").toString("hex");
    const text = `data ${blob} end`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    expect(redactSecrets(text)).not.toContain(blob);
  });

  // C3-6: a combining mark from a NON-basic Mn block (outside U+0300–U+036F)
  // interleaved after each char. The widened \p{Mn} strip must fold it away.
  for (const [name, mark] of [
    ["U+0951 (Devanagari)", "॑"],
    ["U+1DC0 (Diacritical Supplement)", "᷀"],
    ["U+20D0 (for Symbols)", "⃐"],
    ["U+FE20 (Half Marks)", "︠"],
    ["U+064B (Arabic)", "ً"],
  ] as const) {
    it(`C3-6: catches a key interleaved with combining mark ${name}`, () => {
      const interleaved = [...ANT_KEY].map((c) => c + mark).join("");
      const r = scanForSecrets(`key: ${interleaved}`);
      expect(r.clean).toBe(false);
    });
  }

  // C3-8: base64(base64(registered known secret)). The known-value pass now peels
  // the same multi-layer iterative views the catalog pass does, so a doubly-
  // wrapped registered value no longer leaks.
  it("C3-8: catches base64(base64(registered known value)) — known-value inner-decode parity", () => {
    const KNOWN = "correct-horse-battery-staple-passphrase";
    registerRedactedSecretValue(KNOWN);
    try {
      const once = Buffer.from(KNOWN, "utf8").toString("base64");
      const twice = Buffer.from(once, "utf8").toString("base64");
      const r = scanForSecrets(`v=${twice}`);
      expect(r.clean).toBe(false);
      expect(r.matches.some((m) => m.type === "known-secret-value")).toBe(true);
    } finally {
      unregisterRedactedSecretValue(KNOWN);
    }
  });

  // C3-18: three encoding layers. The old fixed one-extra-layer peel stopped at 2
  // layers; the iterative peel (up to MAX_DECODE_DEPTH) recovers the inner key.
  it("C3-18: catches base64(base64(hex(key))) — 3-layer iterative decode", () => {
    const l1 = Buffer.from(ANT_KEY, "utf8").toString("hex");
    const l2 = Buffer.from(l1, "utf8").toString("base64");
    const l3 = Buffer.from(l2, "utf8").toString("base64");
    expect(scanForSecrets(`v=${l3}`).clean).toBe(false);
  });

  // C3-19: one attacker prefix byte before an UNREGISTERED sk-ant key, carried as
  // base64-of-utf16le. The raw catalog's `\b` before `sk-ant` is broken by the
  // prefix; the DERIVED-view catalog (leading `\b` stripped) must still catch it
  // with NO registration.
  it("C3-19: catches base64(utf16le('x'+key)) for an unregistered key (anchor relaxation)", () => {
    const blob = Buffer.from("x" + ANT_KEY, "utf16le").toString("base64");
    const r = scanForSecrets(`payload=${blob}`);
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.type === "obfuscated")).toBe(true);
  });

  // No new false positive: accented prose folds to bare ASCII under the widened
  // \p{Mn} strip but trips no credential/known-value pattern.
  it("C3-6 negative: accented prose (café/naïve/résumé/Zürich) stays clean", () => {
    expect(scanForSecrets("café naïve résumé Zürich coöperate").clean).toBe(true);
  });

  // No new false positive: a normal base64 blob of prose decodes (across the
  // iterative peel) to text that matches no pattern.
  it("negative: base64 of ordinary prose stays clean under iterative decode", () => {
    const blob = Buffer.from(
      "the quarterly report is attached, please review before the sync",
      "utf8"
    ).toString("base64");
    expect(scanForSecrets(`note=${blob}`).clean).toBe(true);
  });

  // Performance / decompression-bomb bound: a large, deeply-nested base64 input
  // must terminate quickly (depth cap + shared MAX_DECODED_BUDGET), not hang.
  it("bounds work on a large nested encoded input (no hang)", () => {
    // ~200KB of nested base64 wrapping. Build by repeatedly re-encoding a chunk.
    let payload = "A".repeat(50_000);
    for (let i = 0; i < 6; i++) {
      payload = Buffer.from(payload, "utf8").toString("base64");
    }
    const text = `blob=${payload.slice(0, 200_000)}`;
    const t0 = Date.now();
    const r = scanForSecrets(text);
    const ms = Date.now() - t0;
    // The call must TERMINATE (budget-bounded), not hang. Work plateaus once the
    // input exceeds what MAX_DECODED_BUDGET allows decoding, so larger inputs
    // don't cost more — the bound holds. Ceiling is generous for CI variance; the
    // point is "bounded, not unbounded," not a tight latency SLA.
    expect(typeof r.clean).toBe("boolean");
    expect(ms).toBeLessThan(10000);
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

// ── Known-secret-value detection (the user's ACTUAL stored secrets) ──────────
describe("scanForSecrets — known-secret-value detection", () => {
  // A long, isSecretShaped value (len>=6, not all-numeric, >=4 distinct chars)
  // that is DELIBERATELY low-entropy readable prose: it trips NO credential
  // pattern and NO entropy run, so when it is NOT registered the scan is clean.
  // That makes the ONLY reason it can flag be the known-value registry — and
  // keeps the "stays clean once unregistered" assertion non-flaky.
  const KNOWN = "correct-horse-battery-staple-passphrase";
  const registered: string[] = [];

  function register(v: string): void {
    registerRedactedSecretValue(v);
    registered.push(v);
  }

  afterEach(() => {
    while (registered.length) unregisterRedactedSecretValue(registered.pop()!);
  });

  it("flags a registered value appearing literally, with a real redactable span", () => {
    register(KNOWN);
    const text = `body={"token":"${KNOWN}"}`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    const m = r.matches.find(x => x.type === "known-secret-value");
    expect(m).toBeTruthy();
    expect(text.slice(m!.startIndex, m!.endIndex)).toBe(KNOWN);
    // Never echoes the value through the match object.
    expect(m!.value).toBe("");
    expect(redactSecrets(text)).not.toContain(KNOWN);
  });

  it("H8: flags a registered value with a combining mark after each char (known-value pass)", () => {
    register(KNOWN);
    const interleaved = [...KNOWN].map((c) => c + "́").join("");
    const r = scanForSecrets(`body=${interleaved}`);
    expect(r.clean).toBe(false);
    expect(r.matches.some((x) => x.type === "known-secret-value")).toBe(true);
  });

  it("H7: flags a registered value as base64-of-UTF-16LE (known-value pass)", () => {
    register(KNOWN);
    const blob = Buffer.from("A".repeat(40) + KNOWN, "utf16le").toString("base64");
    const r = scanForSecrets(`payload=${blob}`);
    expect(r.clean).toBe(false);
    expect(r.matches.some((x) => x.type === "known-secret-value")).toBe(true);
  });

  it("flags the base64-encoded form of a registered value (decode-view reuse)", () => {
    register(KNOWN);
    const blob = Buffer.from(KNOWN, "utf8").toString("base64");
    const text = `payload=${blob}`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    expect(r.matches.some(x => x.type === "known-secret-value")).toBe(true);
    // The whole encoded blob is the redactable span.
    expect(redactSecrets(text)).not.toContain(blob);
  });

  it("does NOT register / flag a non-secret-shaped value (no false positive)", () => {
    register("8080");   // purely numeric → gated out
    register("true");   // too short → gated out
    const text = "server listening on 8080, debug=true";
    expect(scanForSecrets(text).clean).toBe(true);
  });

  it("stays clean once a registered value is unregistered (rotation/deletion)", () => {
    register(KNOWN);
    expect(scanForSecrets(`x=${KNOWN}`).clean).toBe(false);
    unregisterRedactedSecretValue(registered.pop()!);
    expect(scanForSecrets(`x=${KNOWN}`).clean).toBe(true);
  });
});
