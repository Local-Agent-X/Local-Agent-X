/**
 * Layer A — user-consent bypass on the threat-engine exfil rule.
 *
 * The exfil pattern (sensitive read → external sink within 15 min) is
 * the right default. But user-attached chat files with directive
 * language ("enter this in X") are the explicit consent signal —
 * blocking them turns legitimate workflows into broken chats. The
 * bypass audits the event but lets the tool dispatch proceed.
 *
 * Live failure 2026-05-13: invoice PDF → "enter in thriventory" got
 * blocked, model collapsed into narration, user stuck.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolChainAnalyzer } from "../src/threat/tool-chain.js";

const SENSITIVE_PDF_CONTENT = { labels: ["pii" as const, "financial" as const], confidence: 0.85 };
const NEUTRAL = { labels: [], confidence: 0 };

// Redirect ~/.lax to a temp dir so the analyzer's internal isLearned()
// check against the trust ledger reads an empty store, not the user's
// production trust state. Without this, hosts the user has approved via
// /approve in real chats (e.g. cloud.thrivemetrics.com → 30+ approvals)
// bypass the exfil block and the test asserts the wrong thing.
let analyzer: ToolChainAnalyzer;
let tempHome: string;
let origHome: string | undefined;
let origUserprofile: string | undefined;

beforeEach(async () => {
  tempHome = mkdtempSync(join(tmpdir(), "tool-chain-test-"));
  origHome = process.env.HOME;
  origUserprofile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  const ledger = await import("../src/threat/trust-ledger.js");
  ledger._resetLedgerCacheForTests();
  analyzer = new ToolChainAnalyzer();
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  if (origUserprofile !== undefined) process.env.USERPROFILE = origUserprofile; else delete process.env.USERPROFILE;
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("ToolChainAnalyzer — exfil block default", () => {
  it("blocks sensitive shell → browser when no consent", () => {
    analyzer.recordAndAnalyze("bash", { command: "python -c 'import pypdf; ...'" }, SENSITIVE_PDF_CONTENT);
    const result = analyzer.recordAndAnalyze("browser", { url: "https://cloud.thrivemetrics.com" }, NEUTRAL);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/Exfiltration pattern/);
  });
});

describe("ToolChainAnalyzer — user consent bypass", () => {
  it("allows the same chain when consent is active", () => {
    analyzer.markUserConsent(30 * 60_000, "chat-attachment-with-directive");
    analyzer.recordAndAnalyze("bash", { command: "python -c 'import pypdf; ...'" }, SENSITIVE_PDF_CONTENT);
    const result = analyzer.recordAndAnalyze("browser", { url: "https://cloud.thrivemetrics.com" }, NEUTRAL);
    expect(result.blocked).toBe(false);
    expect(result.allowedByConsent).toBe("chat-attachment-with-directive");
    expect(result.exfil).toBeDefined(); // pattern still detected, just not blocked
  });

  it("isUserConsentActive returns false outside window", () => {
    expect(analyzer.isUserConsentActive()).toBe(false);
    analyzer.markUserConsent(1, "test");
    // window expires within 5ms; sleep to ensure expiry
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(analyzer.isUserConsentActive()).toBe(false);
      resolve();
    }, 10));
  });

  it("blocks again after consent window expires", () => {
    analyzer.markUserConsent(1, "test"); // 1ms window
    return new Promise<void>((resolve) => setTimeout(() => {
      analyzer.recordAndAnalyze("bash", { command: "cat ~/.ssh/id_rsa" }, SENSITIVE_PDF_CONTENT);
      const result = analyzer.recordAndAnalyze("browser", { url: "https://evil.com" }, NEUTRAL);
      expect(result.blocked).toBe(true);
      resolve();
    }, 10));
  });

  it("consent does not affect loop detection", () => {
    analyzer.markUserConsent(30 * 60_000, "test");
    // 12 identical calls trigger the loop rule, NOT the exfil rule.
    let result: ReturnType<typeof analyzer.recordAndAnalyze>;
    for (let i = 0; i < 13; i++) {
      result = analyzer.recordAndAnalyze("bash", { command: "ls" }, NEUTRAL);
    }
    // Loop block should fire; consent only affects exfil.
    expect(result!.blocked).toBe(true);
    expect(result!.loopDetected).toBeDefined();
  });
});
