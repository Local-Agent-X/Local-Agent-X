import { describe, it, expect, afterEach } from "vitest";
import { randomBytes, createHash, generateKeyPairSync } from "node:crypto";
import { scanForSecrets, redactSecrets, scanKnownSecretValues } from "./secret-scanner.js";
import { checkOutboundPayload } from "../../tools/http-egress-guard.js";
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
import { peelEncodedRuns, decodeBudgetFor } from "./secret-decode-engine.js";

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

  // `gh auth status` prints its token masked; the model must be able to read
  // whether gh is logged in (2026-09-27: the whole output was withheld).
  it("a masked credential display stays clean, a real or partly masked one does not", () => {
    const ghStatus = [
      "github.com",
      "  ✓ Logged in to github.com account someone (keyring)",
      "  - Active account: true",
      "  - Git operations protocol: https",
      `  - Token: gho_${"*".repeat(36)}`,
      "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
    ].join("\n");
    expect(scanForSecrets(ghStatus).clean).toBe(true);
    expect(scanForSecrets(`password: ${"•".repeat(16)}`).clean).toBe(true);
    expect(scanForSecrets("token: 9f3kQ2mZ8xLp4Rv7Tw").clean).toBe(false);
    expect(scanForSecrets("secret=ab12cd34ef56****").clean).toBe(false);
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
  // must terminate quickly. The scan's decode budget (decodeBudgetFor) is the
  // SOLE bound (no fixed depth cap), and is sufficient for DoS safety.
  it("bounds work on a large nested encoded input (no hang)", () => {
    // ~200KB of nested base64 wrapping. Build by repeatedly re-encoding a chunk.
    let payload = "A".repeat(50_000);
    for (let i = 0; i < 6; i++) {
      payload = Buffer.from(payload, "utf8").toString("base64");
    }
    const text = `blob=${payload.slice(0, 200_000)}`;
    const r = scanForSecrets(text);
    // The point is "bounded, not unbounded": the call must RETURN at all. A
    // budget-bounded scan finishes in well under a second;
    // reaching this assertion proves it terminated. An unbounded regression
    // would never return and trips the explicit test timeout below — so this is
    // deterministic (terminates vs hangs), not a wall-clock latency SLA that
    // flakes on a slow/contended machine.
    expect(typeof r.clean).toBe("boolean");
  }, 30_000);
});

// ── Catalog backtracking bounds ───────────────────────────────────────────
// Two catalog patterns ended a greedy character class with an open `{n,}` and
// then required a literal. On a long alphanumeric run the class ate the whole
// run, failed the literal, and unwound one character at a time from EVERY
// offset. The raw catalog hid it behind a leading `\b` (a base64 blob has
// almost no word boundaries), but the derived-view catalog STRIPS that anchor
// so a prefix byte cannot hide a key — which made the scan quadratic on
// exactly the decoded views the evasion pass feeds back through it. Measured
// on one 150KB view: Password-in-URL 21,200ms, Discord 1,634ms. Both are
// bounded now, so the whole encoded-view scan is 64ms.
describe("scanForSecrets — catalog patterns cannot backtrack quadratically", () => {
  // A long run of the exact shape both patterns grind on: all [A-Za-z0-9], no
  // "://", no ".", starting at an `M` so the Discord class engages too. Unbounded
  // quantifiers take tens of seconds here; bounded ones are linear. The timeout is
  // the assertion (terminates fast vs grinds), with a wide margin over the ~60ms
  // real cost so a slow CI box cannot flake it.
  it("scans a 150KB alphanumeric run without quadratic unwind", () => {
    const run = "M" + "a1B2c3D4e5F6g7H8".repeat(9_400);
    expect(run.length).toBeGreaterThan(150_000);
    expect(scanForSecrets(run).scannedLength).toBe(run.length);
  }, 5_000);

  // The bounds must not be tightened past real credentials: the Discord first
  // segment is base64 of a snowflake id (24 chars for 18 digits, 28 for 20) and
  // URL schemes are short. These pin the upper bounds from the other side.
  it("still detects a Discord token with a 20-digit-snowflake first segment", () => {
    const seg = Buffer.from("12345678901234567890", "utf8").toString("base64").replace(/=+$/, "");
    const token = `M${seg.slice(1)}.GhIjKl.${"a1b2c3d4e5f6g7h8i9j0klmnopq"}`;
    expect(scanForSecrets(`token=${token}`).clean).toBe(false);
  });

  it("still detects credentials in URLs across real scheme lengths", () => {
    for (const url of [
      "ftp://bob:pw@files.example.org/x",
      "postgres://user:s3cr3t@db.example.com:5432/app",
      "mongodb+srv://u:p@cluster0.mongodb.net/test",
    ]) {
      expect(scanForSecrets(url).clean).toBe(false);
    }
  });
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

  // The word-slug exemption must not swallow real keys: a random base64url
  // token split on `-`/`_` almost never has every part read as a word.
  it("flags random base64url tokens that contain - and _ (the word-slug exemption stays narrow)", () => {
    let missed = 0;
    for (let i = 0; i < 2000; i++) {
      const token = randomBytes(30).toString("base64url").slice(0, 40);
      if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[-_]/.test(token)) continue;
      if (scanForSecrets(`value ${token} end`).clean) missed++;
    }
    expect(missed).toBe(0);
  });

  // The hex-of-text exemption must not swallow hex key material: random bytes
  // decode to about 37% printable, far under the text ratio.
  it("flags random hex key material that is not a hash length", () => {
    let missed = 0;
    for (let i = 0; i < 500; i++) {
      const hex = randomBytes(24).toString("hex"); // 48 hex chars
      if (scanForSecrets(`value ${hex} end`).clean) missed++;
    }
    expect(missed).toBe(0);
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
    // TB2 build-pov-ray (2026-10-27): a download refused as carrying a token.
    ["a URL path of title-case words", "https://cept.org/files/download/software/Official-POV-Ray_Source_Code/Old_Versions/POV-Ray/v22/povray-2.2-full.tar.gz.gz"],
    ["an upper/title-case slug", "see Release_Notes-FINAL-Draft_2026 for details"],
    // A PJ's Disneyland download (2026-11-01): the link hex-encodes its asset path.
    ["a download link that hex-encodes a path", "https://kenney.nl/download-link/" + Buffer.from("assets/modular-buildings", "utf8").toString("hex")],
  ];

  for (const [label, text] of benign) {
    it(`stays clean: ${label}`, () => {
      expect(scanForSecrets(text).clean).toBe(true);
    });
  }
});

// ── Public keys are made to be published; private keys are not ──────────────
describe("scanForSecrets — public keys are exempt from the entropy pass, private keys are not", () => {
  // 2026-09-28: the browser fill of a DKIM TXT record (Resend domain setup)
  // was refused six times as "High-Entropy Token". The value is an RSA
  // SubjectPublicKeyInfo — the one thing a DKIM record exists to publish.
  const DKIM = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDPH49nAsZZOJqc7gD+d/jvOrVRrITR7rpferghQHMnnBd8f+VAVi/97aAX+K8ur7Wk27okU9iQ5iu5HuKoI6bvRbnVOIvsjNdD52ob2zuiF3clRSjUSOM6hJ8H72BtdnPzb38IycDBOebSb7J3osdpCmGVwq4LUMfEVaUDrTlD6wIDAQAB";

  it("the real DKIM record value is clean, at the scanner and at the browser sink", () => {
    expect(scanForSecrets(DKIM).clean).toBe(true);
    expect(checkOutboundPayload("browser", DKIM)).toBeNull();
    expect(scanForSecrets(`v=DKIM1; k=rsa; ${DKIM}`).clean).toBe(true);
  });

  it("RSA, EC and Ed25519 SubjectPublicKeyInfo blobs are clean, bare and as PEM", () => {
    const keys = [
      generateKeyPairSync("rsa", { modulusLength: 2048 }),
      generateKeyPairSync("ec", { namedCurve: "P-256" }),
      generateKeyPairSync("ed25519"),
    ];
    for (const { publicKey } of keys) {
      const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
      expect(scanForSecrets(`value: ${der}`).clean, der.slice(0, 20)).toBe(true);
      const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
      expect(scanForSecrets(`key:\n${pem}`).clean).toBe(true);
    }
  });

  it("a private key stays refused: PEM by the catalog, bare PKCS#8 / PKCS#1 DER by the entropy pass", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(scanForSecrets(pem).matches.some(m => m.pattern === "Private Key (PEM)")).toBe(true);
    for (const type of ["pkcs8", "pkcs1"] as const) {
      const der = privateKey.export({ type, format: "der" }).toString("base64");
      const r = scanForSecrets(`value: ${der}`);
      expect(r.clean, type).toBe(false);
      expect(r.matches.some(m => m.type === "high-entropy-token"), type).toBe(true);
    }
  });

  it("a random blob that merely starts like an SPKI is still flagged", () => {
    const fake = "MIGfMA0G" + randomBytes(96).toString("base64");
    expect(scanForSecrets(`value: ${fake}`).clean).toBe(false);
  });
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
// The peel used to take the FIRST inner run per scheme per view. A base64 run
// is 16+ base64 chars, so sixteen characters of filler consumed the scheme's
// only slot and the real blob was never enqueued — one padded object defeated
// the scanner, the taint-overlap check and the canary tripwire at once, all
// three silently (`clean=true`). Every inner run is now taken (docs/adr/0006).
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

  it("a deeper real blob is found behind large fillers in the same object", () => {
    let wrapped = ANT_KEY;
    for (let i = 0; i < 3; i++) wrapped = b64(wrapped);
    const fillers = Array.from({ length: 8 }, (_, i) => `"f${i}":"${"QUFB".repeat(2048)}"`).join(",");
    const text = "p=" + b64(`{"t":"${wrapped}",${fillers}}`);
    expect(scanForSecrets(text).clean).toBe(false);
  });

  // Thousands of inner runs are all inspected: no cap on how many are looked
  // at, so the key placed after 4000 of them is still found.
  it("the key after thousands of inner runs is found (no inner-run cap)", () => {
    const inner = Array.from({ length: 4000 }, (_, i) =>
      Buffer.from(("t" + i).padEnd(12, "x"), "utf8").toString("base64").replace(/=+$/, ""));
    const text = "p=" + b64([...inner, b64(ANT_KEY)].join(" "));
    expect(scanForSecrets(text).clean).toBe(false);
  }, 60_000);

  it("terminates promptly on thousands of inner runs (budget)", () => {
    const inner = Array.from({ length: 12000 }, (_, i) =>
      Buffer.from(("t" + i).padEnd(12, "x"), "utf8").toString("base64").replace(/=+$/, "")).join(" ");
    const text = "p=" + Buffer.from(inner, "utf8").toString("base64");
    const started = Date.now();
    expect(typeof scanForSecrets(text).clean).toBe("boolean");
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

// ── ADR 0006: no filler buys silence ─────────────────────────────────────────
//
// The peel's two old bounds were each a number of filler bytes an attacker
// could prepend: a per-view cap of 256 inner runs (about 6 KB of filler hid a
// wrapped key) and one fixed 256 KB decode pool spent in document order (128 KB
// of filler in front hid a plain base64 key). Both answered `clean=true`. Now
// the pool scales with the input, every inner run is taken, and a run the pool
// cannot cover is reported as an uninspected match — so the scan either sees
// the key or refuses the payload; it never vouches for what it did not read.
describe("ADR 0006 — the peel finds the key or says it could not look", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const wrap = (n: number) => {
    let w = ANT_KEY;
    for (let i = 0; i < n; i++) w = b64(w);
    return w;
  };
  const pad = (i: number) => `"f${i}":"${"a".repeat(16) + String(i).padStart(4, "0")}"`;
  const fillerDoc = (fillers: number, depth: number) =>
    "p=" + b64(`{${Array.from({ length: fillers }, (_, i) => pad(i)).join(",")},"t":"${wrap(depth)}"}`);
  // A percent run nested `layers` deep that hides the key's `a` (%61) behind
  // re-encoded `%` signs, in one run padded to `bodyKB`: each layer's view is
  // the whole run again, so the peel's cost is layers x run length.
  const percentNest = (layers: number, bodyKB: number) =>
    `q=sk-%${"25".repeat(layers)}61nt-api03${"A".repeat(24)}${"x".repeat(bodyKB * 1024)}`;

  for (const depth of [1, 3]) {
    for (const fillers of [256, 1000]) {
      it(`${fillers} fillers before the blob: FOUND (depth ${depth})`, () => {
        expect(scanForSecrets(fillerDoc(fillers, depth)).clean).toBe(false);
      }, 60_000);
    }
  }

  for (const kb of [128, 512]) {
    it(`${kb} KB of decodable filler in front of a base64 key: FOUND as the key`, () => {
      const runs = Array.from({ length: (kb * 1024) / 64 }, () => "QUFB".repeat(16)).join(" ");
      const r = scanForSecrets(`${runs} p=${b64(ANT_KEY)}`);
      expect(r.matches.some((m) => m.type === "obfuscated" && m.pattern.includes("base64"))).toBe(true);
    }, 60_000);
  }

  it("a run the budget cannot cover is an uninspected match over the run, and redaction removes it", () => {
    const text = percentNest(400, 40);
    const r = scanForSecrets(text);
    expect(r.clean).toBe(false);
    const m = r.matches.find((x) => x.type === "uninspected-encoded");
    expect(m).toBeTruthy();
    // The whole whitespace-free token is the percent run, `q=` included.
    expect([m!.startIndex, m!.endIndex]).toEqual([0, text.length]);
    expect(m!.value).toBe("");
    expect(redactSecrets(text)).not.toContain("nt-api03");
  }, 60_000);

  it("a shallow nesting of the same shape is peeled to the key", () => {
    const r = scanForSecrets(percentNest(3, 1));
    expect(r.matches.some((m) => m.type === "obfuscated")).toBe(true);
  });

  it("the known-value block fails closed on an uninspected run too", () => {
    const value = "correct-horse-battery-staple-passphrase";
    registerRedactedSecretValue(value);
    try {
      expect(scanKnownSecretValues(percentNest(400, 40)).some((m) => m.type === "uninspected-encoded")).toBe(true);
      expect(scanKnownSecretValues("nothing encoded here")).toEqual([]);
    } finally {
      unregisterRedactedSecretValue(value);
    }
  }, 60_000);

  it("once the budget is spent, every later run that decodes is reported, and one that does not decode is not", () => {
    // Views of the first blob cost 28 + 14 + 14 chars; the second's 29 + 14.
    // The identifier is 37 chars, which is never valid base64.
    const text = `a=${b64("first blob of ordinary words")} b=${b64("second blob of ordinary words")} c=ThisIsAnIdentifierOfLengthThirtyThree`;
    const peeled = peelEncodedRuns(text, { remaining: 60 });
    expect(peeled.map((p) => p.complete)).toEqual([true, false]);
    expect(peeled.some((p) => p.run.startsWith("ThisIs"))).toBe(false);
  });

  it("the budget scales with the input between a floor and a ceiling", () => {
    expect(decodeBudgetFor(10)).toBe(256 * 1024);
    expect(decodeBudgetFor(1024 * 1024)).toBe(8 * 1024 * 1024);
    expect(decodeBudgetFor(100 * 1024 * 1024)).toBe(16 * 1024 * 1024);
  });

  it("taint and canary see the key behind 1000 fillers too (they read the same peel)", () => {
    const canary = "CANARY-feedface9012-DELTA";
    const doc = (k: string) => "p=" + b64(`{${Array.from({ length: 1000 }, (_, i) => pad(i)).join(",")},"t":"${b64(k)}"}`);
    expect(checkCanariesInPayloadList([canary], doc(canary))).not.toBeNull();
    const sessionId = `adr6-${Date.now()}`;
    recordSensitiveRead(sessionId, "sensitive_file", "/tmp/.env", ANT_KEY);
    try {
      expect(findTaintInPayload(sessionId, doc(ANT_KEY)).length).toBeGreaterThan(0);
    } finally {
      clearSessionTaint(sessionId);
    }
  }, 60_000);

  // A multi-megabyte run used to throw RangeError out of the run regexes (the
  // percent alternation at ~5 MB, the base64 class at ~7 MB) before any
  // verdict. Every egress of a large image went through that.
  it("a 7 MB base64 image and a 6 MB unbroken percent token return a verdict", () => {
    const image = randomBytes(5 * 1024 * 1024).toString("base64");
    expect(image.length).toBeGreaterThan(6_900_000);
    expect(typeof scanForSecrets(image).clean).toBe("boolean");
    const token = "%41" + "x".repeat(6 * 1024 * 1024);
    expect(typeof scanForSecrets(token).clean).toBe("boolean");
  }, 120_000);
});
