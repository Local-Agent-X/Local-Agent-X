import { describe, it, expect, afterEach } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { scanForSecrets, redactSecrets } from "./secret-scanner.js";
import { buildNormalizedView } from "./secret-normalize.js";
import {
  registerRedactedSecretValue,
  unregisterRedactedSecretValue,
} from "./known-secrets.js";
import {
  recordSensitiveRead,
  findTaintInPayload,
  checkEgressTaintWithPayload,
  clearSessionTaint,
} from "../../data-lineage/taint.js";
import { checkCanariesInPayloadList } from "../../threat/canaries.js";
import { iterativeRunViews, ENCODED_SCHEMES } from "./secret-decode-engine.js";

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
  // layers; the iterative peel (budget-bounded, no depth cap) recovers the key.
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
  // must terminate quickly. The shared MAX_DECODED_BUDGET byte counter is the
  // SOLE bound now (no fixed depth cap), and is sufficient for DoS safety.
  it("bounds work on a large nested encoded input (no hang)", () => {
    // ~200KB of nested base64 wrapping. Build by repeatedly re-encoding a chunk.
    let payload = "A".repeat(50_000);
    for (let i = 0; i < 6; i++) {
      payload = Buffer.from(payload, "utf8").toString("base64");
    }
    const text = `blob=${payload.slice(0, 200_000)}`;
    const r = scanForSecrets(text);
    // The point is "bounded, not unbounded": the call must RETURN at all. A
    // budget-bounded scan (MAX_DECODED_BUDGET) finishes in well under a second;
    // reaching this assertion proves it terminated. An unbounded regression
    // would never return and trips the explicit test timeout below — so this is
    // deterministic (terminates vs hangs), not a wall-clock latency SLA that
    // flakes on a slow/contended machine.
    expect(typeof r.clean).toBe("boolean");
  }, 30_000);
});

// ── R4-14: category-Cf format-char interleaving (bidi + zero-width) ───────────
// The scanner view folds NFKC/NFKD + strips Mn/Me + controls, but the bidi format
// controls (U+202A–202E, U+2066–2069) are NFKC-stable and were NOT stripped, so a
// secret interleaved with U+202E stayed non-contiguous and EVERY pass (catalog,
// normalized-view, known-value) missed it — http-egress-guard then allowed
// egress, and a receiver that strips \p{Cf} recovers the live key. buildNormalized
// View now strips ALL \p{Cf} from the scanner view, folding the run to contiguous.
describe("scanForSecrets — R4-14 category-Cf format-char interleaving", () => {
  const registered: string[] = [];
  afterEach(() => {
    while (registered.length) unregisterRedactedSecretValue(registered.pop()!);
  });

  // Interleave a format char between EVERY character of the key.
  function interleave(s: string, fmt: string): string {
    return [...s].map((c) => c + fmt).join("");
  }

  it("R4-14: catches an sk-ant key interleaved with U+202E (RLO) — was clean", () => {
    const obf = interleave(ANT_KEY, "‮");
    const text = `key: ${obf}`;
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    expect(redactSecrets(text)).not.toContain(obf);
  });

  it("R4-14: catches an sk-ant key interleaved with U+2066 (LRI)", () => {
    const r = scanForSecrets(`key: ${interleave(ANT_KEY, "⁦")}`);
    expect(r.clean).toBe(false);
  });

  it("R4-14: catches a REGISTERED known value interleaved with U+202E (known-value pass)", () => {
    const KNOWN = "correct-horse-battery-staple-passphrase";
    registerRedactedSecretValue(KNOWN);
    registered.push(KNOWN);
    const r = scanForSecrets(`body=${interleave(KNOWN, "‮")}`);
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.type === "known-secret-value")).toBe(true);
  });

  it("R4-14: catches a REGISTERED known value interleaved with U+2066 (known-value pass)", () => {
    const KNOWN = "correct-horse-battery-staple-passphrase";
    registerRedactedSecretValue(KNOWN);
    registered.push(KNOWN);
    const r = scanForSecrets(`body=${interleave(KNOWN, "⁦")}`);
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.type === "known-secret-value")).toBe(true);
  });

  // Build-time-style invariant over the fold itself: a representative set of every
  // category-Cf sub-kind (bidi controls, zero-width, soft hyphen, BOM, joiners),
  // interleaved into a known secret, must ALL fold to a contiguous run in
  // buildNormalizedView — proving no Cf char re-opens the gap. Asserts BOTH the
  // fold (the normalized view contains the bare secret) AND end-to-end detection.
  const CF_CODEPOINTS: ReadonlyArray<[string, number]> = [
    ["U+202A LRE", 0x202a],
    ["U+202B RLE", 0x202b],
    ["U+202C PDF", 0x202c],
    ["U+202D LRO", 0x202d],
    ["U+202E RLO", 0x202e],
    ["U+2066 LRI", 0x2066],
    ["U+2067 RLI", 0x2067],
    ["U+2068 FSI", 0x2068],
    ["U+2069 PDI", 0x2069],
    ["U+200B ZWSP", 0x200b],
    ["U+200C ZWNJ", 0x200c],
    ["U+200D ZWJ", 0x200d],
    ["U+00AD SHY", 0x00ad],
    ["U+FEFF BOM", 0xfeff],
    ["U+2060 WJ", 0x2060],
    ["U+061C ALM", 0x061c],
  ];

  for (const [name, cp] of CF_CODEPOINTS) {
    it(`R4-14 invariant: buildNormalizedView strips ${name} so the secret folds contiguous`, () => {
      const fmt = String.fromCodePoint(cp);
      const obf = [...ANT_KEY].map((c) => c + fmt).join("");
      const { normalized } = buildNormalizedView(`key: ${obf}`);
      expect(normalized).not.toContain(fmt); // the Cf char is gone from the view
      expect(normalized).toContain(ANT_KEY); // and the bare secret is contiguous
      expect(scanForSecrets(`key: ${obf}`).clean).toBe(false); // and detected
    });
  }

  // No new false positive: a normal ZWJ emoji sequence (U+200D joins) and ordinary
  // accented prose must still scan CLEAN — stripping \p{Cf} in the SCANNER view is
  // detection-only and trips no credential/known-value pattern.
  it("R4-14 negative: a ZWJ emoji sequence in ordinary text stays clean", () => {
    // 👨‍👩‍👧‍👦 family emoji = person glyphs joined by U+200D ZWJ.
    const text = "the family 👨‍👩‍👧‍👦 went to the park";
    expect(scanForSecrets(text).clean).toBe(true);
  });

  it("R4-14 negative: bidi-marked accented prose stays clean", () => {
    const text = "résumé ‫مرحبا‬ café naïve";
    expect(scanForSecrets(text).clean).toBe(true);
  });
});

// ── decode-depth: deeper-than-5 encoding nesting is now scanned ───────────────
// The decode peel was bounded by BOTH a fixed MAX_DECODE_DEPTH (=5) AND the shared
// byte budget. A secret wrapped in >5 layers stopped at depth 5 even with budget
// left. The fixed cap was removed (budget is the sole, DoS-safe bound), so deeper
// nesting is now peeled and caught.
describe("scanForSecrets — decode-depth: budget-only bound (no fixed depth cap)", () => {
  it("catches a 6-layer base64-wrapped key (was clean: stopped at depth 5)", () => {
    let payload = ANT_KEY;
    for (let i = 0; i < 6; i++) {
      payload = Buffer.from(payload, "utf8").toString("base64");
    }
    expect(scanForSecrets(`v=${payload}`).clean).toBe(false);
  });

  it("catches a 7-layer base64-wrapped key (budget permitting)", () => {
    let payload = ANT_KEY;
    for (let i = 0; i < 7; i++) {
      payload = Buffer.from(payload, "utf8").toString("base64");
    }
    expect(scanForSecrets(`v=${payload}`).clean).toBe(false);
  });

  it("negative: a deep base64 wrap of ordinary prose stays clean", () => {
    let payload = "the quarterly planning meeting is scheduled for next week";
    for (let i = 0; i < 7; i++) {
      payload = Buffer.from(payload, "utf8").toString("base64");
    }
    expect(scanForSecrets(`note=${payload}`).clean).toBe(true);
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

describe("scanForSecrets — Password in URL is scheme-anchored", () => {
  it("detects userinfo credentials in a real URL and redacts them", () => {
    const url = "https://svc:s3cr3tPass@api.example.com/v1";
    const r = scanForSecrets(url);
    expect(r.matches.some(m => m.pattern === "Password in URL")).toBe(true);
    expect(redactSecrets(url)).not.toContain("s3cr3tPass");
  });

  // The old pattern (`//[^:]+:[^@]+@[^\s/]+`) matched any `//…:…@…` span, so a
  // schema.org JSON-LD blob full of `@type`/`@context` latched a research
  // session into network-restriction (2026-07-23). A doc page is not a secret.
  it("stays clean on schema.org JSON-LD (no bare-// false positive)", () => {
    const jsonld = String.raw`{"@context":"https://schema.org","@type":"Person","sameAs":["https://x.com/y"]}`;
    expect(scanForSecrets(jsonld).clean).toBe(true);
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

// ── S1: padded inner runs (ADR 0004 step 1) ──────────────────────────────────
// iterativeRunViews used to take the FIRST inner run per scheme per view
// (`fresh.exec(v)`). BASE64_RUN_RE matches 16+ base64 chars, so sixteen
// characters of filler consumed the scheme's only slot and the real blob was
// never enqueued — one padded object defeated the scanner, the taint-overlap
// check and the canary tripwire at once, all three silently (`clean=true`).
// Every inner run is now enumerated, capped per view and drained in penalty
// order so the enumeration can never starve a detection that already worked.
describe("scanForSecrets — S1 padded inner runs (all three subsystems)", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const hexOf = (s: string) => Buffer.from(s, "utf8").toString("hex");
  const P16 = "a".repeat(16);
  const P15 = "a".repeat(15);

  // Each shape is a BUILDER over the carried secret, so the identical document
  // shape can be re-instantiated with a canary token for the canary assertion.
  const shapes: Array<[string, (secret: string) => string]> = [
    ["pad(16) before the blob", (k) => `p=${b64(JSON.stringify({ pad: P16, t: b64(k) }))}`],
    ["pad(16) after the blob", (k) => `p=${b64(JSON.stringify({ t: b64(k), pad: P16 }))}`],
    ["pad(15) before the blob", (k) => `p=${b64(JSON.stringify({ pad: P15, t: b64(k) }))}`],
    ["two pads before the blob", (k) => `p=${b64(JSON.stringify({ p1: P16, p2: "b".repeat(20), t: b64(k) }))}`],
    ["hex-shaped pad, base64 blob", (k) => `p=${b64(JSON.stringify({ pad: "ab".repeat(20), t: b64(k) }))}`],
    ["percent-shaped pad, base64 blob", (k) => `p=${b64(JSON.stringify({ pad: "%41%42%43%44%45%46%47%48%49", t: b64(k) }))}`],
    ["pad + blob nested two layers", (k) => `p=${b64(JSON.stringify({ pad: P16, t: b64(b64(k)) }))}`],
    ["pad + blob nested three layers", (k) => `p=${b64(JSON.stringify({ pad: P16, t: b64(b64(b64(k))) }))}`],
    ["pad + hex inner blob", (k) => `p=${b64(JSON.stringify({ pad: P16, t: hexOf(k) }))}`],
    ["pad in a hex outer blob", (k) => `p=${hexOf(JSON.stringify({ pad: P16, t: b64(k) }))}`],
  ];

  for (const [name, build] of shapes) {
    it(`scanner catches: ${name}`, () => {
      expect(scanForSecrets(build(ANT_KEY)).clean).toBe(false);
    });
  }

  // All three subsystems share the same peel (decodedPayloadViews), so the
  // scanner alone is not proof the hole is closed. Assert the taint-overlap
  // check and the canary matcher on the SAME padded document.
  it("all three subsystems catch the padded payload (scanner + taint + canary)", () => {
    const build = shapes[0][1];
    const payload = build(ANT_KEY);

    expect(scanForSecrets(payload).clean).toBe(false);

    const sessionId = `s1-padded-${Date.now()}`;
    recordSensitiveRead(sessionId, "sensitive_file", "/tmp/.env", ANT_KEY);
    try {
      expect(findTaintInPayload(sessionId, payload).length).toBeGreaterThan(0);
      // Fully-fingerprinted taint clears an unrelated payload, so `blocked` here
      // is real overlap evidence, not the presence floor.
      const egress = checkEgressTaintWithPayload(sessionId, payload);
      expect(egress.blocked).toBe(true);
      expect(egress.evidence.length).toBeGreaterThan(0);
    } finally {
      clearSessionTaint(sessionId);
    }

    const canary = "CANARY-deadbeef1234-ALPHA";
    expect(checkCanariesInPayloadList([canary], build(canary))).not.toBeNull();
  });

  it("taint + canary catch every padding variant too", () => {
    const canary = "CANARY-c0ffee5678-BRAVO";
    for (const [name, build] of shapes) {
      const sessionId = `s1-var-${name}`;
      recordSensitiveRead(sessionId, "sensitive_file", "/tmp/.env", ANT_KEY);
      try {
        expect(findTaintInPayload(sessionId, build(ANT_KEY)).length, `taint: ${name}`).toBeGreaterThan(0);
      } finally {
        clearSessionTaint(sessionId);
      }
      expect(checkCanariesInPayloadList([canary], build(canary)), `canary: ${name}`).not.toBeNull();
    }
  });

  it("previously-caught shapes stay caught (no regression)", () => {
    expect(scanForSecrets(`key ${ANT_KEY}`).clean).toBe(false);
    expect(scanForSecrets(`p=${b64(ANT_KEY)}`).clean).toBe(false);
    expect(scanForSecrets(`p=${b64(JSON.stringify({ t: b64(ANT_KEY) }))}`).clean).toBe(false);
  });

  it("negative: a padded object with no secret in it stays clean", () => {
    const doc = b64(JSON.stringify({ pad: P16, t: b64("the quick brown fox jumps over it") }));
    expect(scanForSecrets(`p=${doc}`).clean).toBe(true);
  });

  // The penalty ordering is what keeps enumeration from making the shared-budget
  // starvation WORSE: newly-enumerated siblings are strictly lower priority than
  // the chain the first-run-only code walked. Without it, this exact document
  // measured FOUND -> MISSED (8 x 8KB fillers around a 3-layer-wrapped key).
  it("enumerating siblings does not starve a deeper real blob (penalty order)", () => {
    let wrapped = ANT_KEY;
    for (let i = 0; i < 3; i++) wrapped = b64(wrapped);
    const fillers = Array.from({ length: 8 }, (_, i) => `"f${i}":"${"QUFB".repeat(2048)}"`).join(",");
    const text = "p=" + b64(`{"t":"${wrapped}",${fillers}}`);
    expect(scanForSecrets(text).clean).toBe(false);
  });

  // The cap must BIND independently of the byte budget: hand iterativeRunViews a
  // deliberately generous budget and a document whose decoded view holds
  // thousands of inner runs. Capped at 256 this peel yields ~770 views for ~108KB
  // of decode; uncapped it yields 12002 views for ~198KB — so deleting the cap
  // flips this assertion even though the scanner's own MAX_DECODED_BUDGET would
  // have hidden the difference.
  it("the per-view cap bounds the peel even under a generous budget", () => {
    const inner = Array.from({ length: 4000 }, (_, i) =>
      Buffer.from(("t" + i).padEnd(12, "x"), "utf8").toString("base64").replace(/=+$/, "")).join(" ");
    const outer = Buffer.from(inner, "utf8").toString("base64");
    const budget = { remaining: 64 * 1024 * 1024 };
    const views = iterativeRunViews(ENCODED_SCHEMES[0], outer, budget);
    expect(views.length).toBeLessThan(4000);
  });

  // The cap's reason for existing: thousands of enqueueable inner runs must
  // terminate promptly, not hang.
  it("terminates promptly on thousands of inner runs (cap)", () => {
    const inner = Array.from({ length: 12000 }, (_, i) =>
      Buffer.from(("t" + i).padEnd(12, "x"), "utf8").toString("base64").replace(/=+$/, "")).join(" ");
    const text = "p=" + Buffer.from(inner, "utf8").toString("base64");
    const started = Date.now();
    expect(typeof scanForSecrets(text).clean).toBe("boolean");
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

// ── S2: the penalty-order invariant, pinned directly ─────────────────────────
//
// The entire safety argument for enumerating every inner run (rather than only
// the first, as the pre-enumeration code did) is ONE invariant:
//
//   penalty 0 is exactly the chain the old first-run-only code walked, and a
//   child's penalty is never below its parent's, so the whole old traversal is
//   materialized — same views, same order, same budget draw — BEFORE any
//   newly-enumerated sibling is charged a single byte. Enumeration can then
//   only ADD detections, never starve one that already worked.
//
// Behavioral tests do not bind that. Mutating the penalty arithmetic (+n+1,
// +max(n-1,0), +min(n,1)) leaves the whole suite green while breaking it. So
// assert it DIRECTLY: run a frozen reference implementation of the old walk and
// require its output to be an exact hash-for-hash PREFIX of the current one.
describe("S2 — iterativeRunViews penalty order (invariant, not behavior)", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const sha = (s: string) => createHash("sha256").update(s, "latin1").digest("hex");
  type Scheme = (typeof ENCODED_SCHEMES)[number];

  // FROZEN reference: the first-run-only walk exactly as it stood before the
  // penalty-ordered peel (secret-decode-engine.ts @ 3dfd476f^). A BFS queue,
  // one `exec` per scheme per view (never matchAll), the same shared byte
  // budget charged per materialized view. Do not "improve" this — it is the
  // baseline the current engine must not regress against, so it must keep
  // walking the OLD chain even after the engine changes.
  function refRunDecodeViews(scheme: Scheme, run: string): string[] {
    // Mirrors bufferTextViews: latin1 + both-endian utf16le for the two
    // byte-bearing schemes; percent has a single textual decoding. The BYTES
    // come from the engine's own exported decode, so this cannot drift on
    // decode rules — only the (frozen) list of text interpretations is local.
    const decoded = scheme.decode(run);
    if (decoded === null) return [];
    if (scheme.label === "percent") return [decoded];
    const buf = Buffer.from(decoded, "latin1");
    const views = [buf.toString("latin1"), buf.toString("utf16le")];
    if (buf.length >= 2 && buf.length % 2 === 0) {
      const swapped = Buffer.from(buf);
      swapped.swap16();
      views.push(swapped.toString("utf16le"));
    }
    return views;
  }

  function referenceFirstRunWalk(
    outerScheme: Scheme,
    outerRun: string,
    budget: { remaining: number }
  ): string[] {
    const collected: string[] = [];
    let queue: Array<{ run: string; scheme: Scheme }> = [{ run: outerRun, scheme: outerScheme }];
    while (queue.length > 0 && budget.remaining > 0) {
      const nextLayer: Array<{ run: string; scheme: Scheme }> = [];
      for (const item of queue) {
        if (budget.remaining <= 0) break;
        const views = refRunDecodeViews(item.scheme, item.run);
        if (views.length === 0) continue;
        for (const v of views) {
          if (budget.remaining <= 0) break;
          budget.remaining -= v.length;
          collected.push(v);
          for (const inner of ENCODED_SCHEMES) {
            const fresh = new RegExp(inner.re.source, inner.re.flags);
            const im = fresh.exec(v);
            if (im) nextLayer.push({ run: im[0], scheme: inner });
          }
        }
      }
      queue = nextLayer;
    }
    return collected;
  }

  // ── document spread ────────────────────────────────────────────────────────
  const wrap = (n: number) => {
    let w = ANT_KEY;
    for (let i = 0; i < n; i++) w = b64(w);
    return w;
  };
  const fillerOf = (kb: number) => "QUFB".repeat((kb * 1024) / 4);

  const docs: Array<[string, string]> = [];
  for (const fillerKB of [8, 48, 96]) {
    for (const pads of [1, 4]) {
      for (const depth of [1, 2, 3]) {
        for (const blobFirst of [true, false]) {
          const t = `"t":"${wrap(depth)}"`;
          const f = Array.from({ length: pads }, (_, i) => `"f${i}":"${fillerOf(fillerKB)}"`);
          const body = blobFirst ? [t, ...f] : [...f, t];
          docs.push([
            `filler=${fillerKB}KB/n=${pads}/depth=${depth}/${blobFirst ? "blob-first" : "blob-last"}`,
            b64(`{${body.join(",")}}`),
          ]);
        }
      }
    }
  }
  // many-pad: 64 short pads crowding the real blob out of the front of the view.
  docs.push([
    "many-pad(64) then blob",
    b64(
      `{${Array.from({ length: 64 }, (_, i) => `"p${i}":"${"a".repeat(16)}"`).join(",")},"t":"${wrap(2)}"}`
    ),
  ]);
  // decode bomb: a sibling that itself peels several layers deep and expands.
  docs.push([
    "decode bomb sibling",
    b64(`{"bomb":"${b64(b64(b64(fillerOf(32))))}","t":"${wrap(3)}"}`),
  ]);
  // shallow prose noise around a single-layer blob.
  docs.push(["shallow noise", b64(`the quick brown fox ${wrap(1)} jumps over the lazy dog`)]);

  const BUDGETS = [4 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024];

  it("the old first-run-only walk is an exact prefix of the penalty-ordered peel", () => {
    let pairs = 0;
    for (const [name, run] of docs) {
      for (const B of BUDGETS) {
        pairs++;
        const ref = referenceFirstRunWalk(ENCODED_SCHEMES[0], run, { remaining: B });
        const now = iterativeRunViews(ENCODED_SCHEMES[0], run, { remaining: B });
        expect(
          now.length,
          `${name} @ ${B}B: peel shorter than the old walk`
        ).toBeGreaterThanOrEqual(ref.length);
        for (let i = 0; i < ref.length; i++) {
          expect(sha(now[i]), `${name} @ ${B}B: view #${i} diverges from the old walk`).toBe(
            sha(ref[i])
          );
        }
      }
    }
    expect(pairs).toBe(docs.length * BUDGETS.length);
  }, 300_000);

  // The prefix property alone still permits collapsing sibling penalties
  // (`penalty + min(n, 1)`): the n=0 chain stays intact, so the old traversal is
  // preserved, but every later sibling is promoted into the SAME bucket as the
  // real blob's own deeper layers and drains the shared budget ahead of them.
  // Measured against the parent commit that is not a regression — which is why
  // no behavioral test caught it — but it is strictly worse than the shipped
  // ordering, so pin it: a blob at sibling index 1 must survive the fillers
  // that follow it.
  it("a sibling-index-1 blob is not starved by the fillers that follow it", () => {
    const filler = "QUFB".repeat(3 * 1024); // 12KB each
    const fillers = Array.from({ length: 8 }, (_, i) => `"f${i}":"${filler}"`).join(",");
    const text = "p=" + b64(`{"head":"${"a".repeat(16)}","t":"${wrap(3)}",${fillers}}`);
    expect(scanForSecrets(text).clean).toBe(false);
  }, 60_000);
});

// ── S2: MAX_INNER_RUNS_PER_VIEW is a SECURITY boundary — pin it exactly ──────
// The cap decides how many filler runs an attacker must prepend before the real
// blob falls off the enumeration. `views.length < 4000` cannot tell 255 from
// 257. This can: with 255 fillers the blob is inner run index 255 — the last
// index the cap admits — and is FOUND; with 256 it is index 256 and MISSED.
// Both directions are asserted, at one and at three wrap layers, so moving the
// cap by one in either direction, or flipping `n < CAP` to `n <= CAP`, is red.
describe("S2 — the inner-run cap boundary (255 found / 256 missed)", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const wrap = (n: number) => {
    let w = ANT_KEY;
    for (let i = 0; i < n; i++) w = b64(w);
    return w;
  };
  // Each filler is one BASE64_RUN_RE match (16+ chars of the class). JSON
  // punctuation terminates each run, so run index == position in the object.
  const pad = (i: number) => `"f${i}":"${"a".repeat(16) + String(i).padStart(4, "0")}"`;
  const doc = (fillers: number, depth: number) =>
    "p=" +
    b64(
      `{${Array.from({ length: fillers }, (_, i) => pad(i)).join(",")}${
        fillers ? "," : ""
      }"t":"${wrap(depth)}"}`
    );

  for (const depth of [1, 3]) {
    it(
      `255 fillers before the blob: still FOUND (depth ${depth})`,
      () => {
        expect(scanForSecrets(doc(255, depth)).clean).toBe(false);
      },
      60_000
    );

    it(
      `256 fillers before the blob: MISSED — the cap binds here (depth ${depth})`,
      () => {
        expect(scanForSecrets(doc(256, depth)).clean).toBe(true);
      },
      60_000
    );
  }
});
