import { describe, it, expect } from "vitest";
import {
  recordSensitiveRead,
  retractProvisionalTaint,
  checkEgressTaint,
  clearSessionTaint,
  detectSecretsInOutput,
  redactSecretSpans,
} from "./index.js";

describe("detectSecretsInOutput — positive cases", () => {
  // `kinds` carry the CANONICAL catalog name (credential-patterns.ts). The four
  // shapes that used to live in a local supplemental set (Google keys, JWTs,
  // OpenAI scoped keys, bare PEM markers) are now in that catalog too.
  it("matches OpenAI-style API key", () => {
    const res = detectSecretsInOutput("sk-abc123xyz456789012345");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("OpenAI API Key");
  });

  it("matches Anthropic-style API key", () => {
    const secret = "sk-ant-" + "deadbeef" + "a".repeat(30);
    const res = detectSecretsInOutput(secret);
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Anthropic API Key");
  });

  it("matches AWS access key ID", () => {
    const res = detectSecretsInOutput("AKIAIOSFODNN7EXAMPLE");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("AWS Access Key");
  });

  it("matches AWS secret access key when keyword anchors the line", () => {
    const res = detectSecretsInOutput("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("AWS Secret Key");
  });

  it("matches GitHub PAT (ghp_ form)", () => {
    const res = detectSecretsInOutput("ghp_" + "a".repeat(36));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("GitHub PAT");
  });

  it("matches Slack bot token", () => {
    const res = detectSecretsInOutput("xoxb-1234567890-abcdef123456");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Slack Token");
  });

  it("matches Google API key", () => {
    const res = detectSecretsInOutput("AIza" + "a".repeat(35));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Google API Key");
  });

  it("matches JWT-shaped string", () => {
    const seg = "a".repeat(20);
    const jwt = `eyJ${seg}.eyJ${seg}.${seg}`;
    const res = detectSecretsInOutput(jwt);
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("JWT");
  });

  it("matches private key block markers", () => {
    const res = detectSecretsInOutput("-----BEGIN RSA PRIVATE KEY-----");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Private Key Marker (PEM)");
  });

  it("matches keyword-near-value heuristic", () => {
    const res = detectSecretsInOutput("password: abcdef1234567890ABCDE");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Key-Value Secret");
  });

  // S1 convergence: modern keys that exist in the canonical catalog but were
  // ABSENT from the old inline taint set — previously the egress guard caught
  // them leaving while the taint path did NOT (the documented defect). Now the
  // taint path sources the canonical catalog, so they taint too.
  it("matches a Stripe live key (was missed by the old inline set)", () => {
    const res = detectSecretsInOutput("sk_live_" + "a".repeat(24));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Stripe Live Key");
  });

  it("matches a Supabase token (was missed by the old inline set)", () => {
    const res = detectSecretsInOutput("sbp_" + "a".repeat(24));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Supabase Token");
  });

  it("matches a SendGrid key (was missed by the old inline set)", () => {
    const res = detectSecretsInOutput("SG." + "a".repeat(22) + "." + "b".repeat(22));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Sendgrid Key");
  });

  it("matches an npm token (was missed by the old inline set)", () => {
    const res = detectSecretsInOutput("npm_" + "a".repeat(36));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("npm Token");
  });
});
describe("detectSecretsInOutput — negative cases", () => {
  it("does not match plain text", () => {
    const res = detectSecretsInOutput("hello world");
    expect(res.matched).toBe(false);
    expect(res.kinds).toEqual([]);
  });

  it("does not match random prose without secret shapes", () => {
    const res = detectSecretsInOutput("some random text without secrets");
    expect(res.matched).toBe(false);
    expect(res.kinds).toEqual([]);
  });

  it("does not match file metadata lines", () => {
    const res = detectSecretsInOutput("file.txt size 1024");
    expect(res.matched).toBe(false);
  });

  it("does not match a plain GitHub URL", () => {
    const res = detectSecretsInOutput("see https://github.com/foo/bar for more");
    expect(res.matched).toBe(false);
  });
});

describe("openai-key pattern precision (false-positive that bricked agent runs)", () => {
  it("does NOT match a hyphenated slug from a public page", () => {
    // Real OpenAI keys have a contiguous base62 body; the old pattern allowed
    // inner `-`/`_`, so a product slug tripped it and tainted the whole run.
    const res = detectSecretsInOutput("order code sk-supplement-formula-2026-batch-xyz here");
    expect(res.matched).toBe(false);
  });

  it("still matches a real legacy key shape", () => {
    const res = detectSecretsInOutput("sk-" + "Ab12".repeat(6));
    expect(res.kinds).toContain("OpenAI API Key");
  });

  it("still matches a project-scoped key shape", () => {
    // Project/service/admin keys aren't covered by the canonical "OpenAI API
    // Key" shape (its body stops at the `-` after `proj`), so the catalog
    // carries a dedicated "OpenAI Scoped Key" entry for them.
    const res = detectSecretsInOutput("sk-proj-" + "Ab12".repeat(8));
    expect(res.kinds).toContain("OpenAI Scoped Key");
  });
});

describe("redactSecretSpans — surgical inline redaction for untrusted inbound content", () => {
  it("replaces the secret span with a marker and keeps surrounding text", () => {
    const body = "Trends report. Contact AKIAIOSFODNN7EXAMPLE for access. The end.";
    const red = redactSecretSpans(body);
    expect(red.matched).toBe(true);
    expect(red.kinds).toContain("AWS Access Key");
    expect(red.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(red.text).toContain("[redacted-secret:AWS Access Key]");
    // The non-secret content survives — the whole page isn't discarded.
    expect(red.text).toContain("Trends report.");
    expect(red.text).toContain("The end.");
  });

  it("redacts every occurrence, not just the first", () => {
    const body = `a AKIA0000000000000000 b AKIA1111111111111111 c`;
    const red = redactSecretSpans(body);
    expect(red.text).not.toMatch(/AKIA\d/);
    expect(red.text.match(/\[redacted-secret:AWS Access Key\]/g)?.length).toBe(2);
  });

  it("passes benign content through unchanged", () => {
    const body = "Creatine and collagen demand rose in Q2 2026.";
    const red = redactSecretSpans(body);
    expect(red.matched).toBe(false);
    expect(red.text).toBe(body);
  });
});

describe("detectSecretsInOutput — 256KB cap", () => {
  it("does not detect a secret pattern past the 256KB cap", () => {
    const filler = "x".repeat(300_000);
    const input = filler + " AKIA0000000000000000";
    const res = detectSecretsInOutput(input);
    expect(res.matched).toBe(false);
  });

  it("detects a secret pattern within the cap", () => {
    const filler = "x".repeat(100_000);
    const input = filler + " AKIA0000000000000000";
    const res = detectSecretsInOutput(input);
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("AWS Access Key");
  });
});

describe("detectSecretsInOutput — no-leak invariant", () => {
  it("never returns the matched substring (only kind labels)", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const res = detectSecretsInOutput(`some prefix ${secret} some suffix`);
    expect(res.matched).toBe(true);
    // Neither the kinds array nor any string within it should contain the
    // secret. This protects against accidental log leaks.
    for (const k of res.kinds) {
      expect(k).not.toContain(secret);
    }
    expect(JSON.stringify(res)).not.toContain(secret);
  });
});

describe("secret-taint integration", () => {
  it("end-to-end via bash stdout: detection + recordSensitiveRead blocks egress", () => {
    clearSessionTaint("test-end-to-end");
    expect(checkEgressTaint("test-end-to-end").blocked).toBe(false);

    const fakeStdout = "AKIA0000000000000000";
    const det = detectSecretsInOutput(fakeStdout);
    expect(det.matched).toBe(true);
    if (det.matched) {
      recordSensitiveRead("test-end-to-end", "secret", `bash:${det.kinds.join(",")}`);
    }
    expect(checkEgressTaint("test-end-to-end").blocked).toBe(true);
  });

  it("owned-source read still taints when recorded (primitive unchanged)", () => {
    clearSessionTaint("test-owned-e2e");
    expect(checkEgressTaint("test-owned-e2e").blocked).toBe(false);
    // Owned sources (local fs / bash / sql) still taint via the primitive.
    recordSensitiveRead("test-owned-e2e", "secret", "bash:aws-access-key");
    expect(checkEgressTaint("test-owned-e2e").blocked).toBe(true);
  });
});

// retractProvisionalTaint is the delivery-point invariant's registry primitive:
// the execute phase sets an arg-derived floor BEFORE a sensitive read, then
// withdraws it when the result was fully stubbed (nothing entered context).
describe("retractProvisionalTaint", () => {
  const PAIR = { source: "sensitive_file" as const, target: "/Users/x/.ssh/id_rsa" };

  it("removes a content-less floor entry, unblocking egress", () => {
    const sid = "retract-basic";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, PAIR.source, PAIR.target); // provisional (no content)
    expect(checkEgressTaint(sid).blocked).toBe(true);
    expect(retractProvisionalTaint(sid, [PAIR])).toBe(1);
    expect(checkEgressTaint(sid).blocked).toBe(false);
  });

  it("NEVER removes a content-bearing entry — delivered bytes stay provable", () => {
    const sid = "retract-content";
    clearSessionTaint(sid);
    // A content-bearing record means bytes WERE delivered on some call.
    recordSensitiveRead(sid, PAIR.source, PAIR.target, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----");
    expect(retractProvisionalTaint(sid, [PAIR])).toBe(0);
    expect(checkEgressTaint(sid).blocked).toBe(true);
    clearSessionTaint(sid);
  });

  it("removes only the named pairs — other floor entries keep blocking", () => {
    const sid = "retract-scoped";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, PAIR.source, PAIR.target);
    recordSensitiveRead(sid, "sensitive_file", "/Users/x/.aws/credentials");
    expect(retractProvisionalTaint(sid, [PAIR])).toBe(1);
    expect(checkEgressTaint(sid).blocked).toBe(true); // .aws floor still up
    clearSessionTaint(sid);
  });

  it("is a no-op on a clean session or an empty pair list", () => {
    const sid = "retract-noop";
    clearSessionTaint(sid);
    expect(retractProvisionalTaint(sid, [PAIR])).toBe(0);
    recordSensitiveRead(sid, PAIR.source, PAIR.target);
    expect(retractProvisionalTaint(sid, [])).toBe(0);
    expect(checkEgressTaint(sid).blocked).toBe(true);
    clearSessionTaint(sid);
  });
});
