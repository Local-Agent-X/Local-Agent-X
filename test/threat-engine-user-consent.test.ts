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

import { describe, it, expect, beforeEach } from "vitest";
import { ToolChainAnalyzer } from "../src/threat/tool-chain.js";

const SENSITIVE_PDF_CONTENT = { labels: ["pii" as const, "financial" as const], confidence: 0.85 };
const NEUTRAL = { labels: [], confidence: 0 };

let analyzer: ToolChainAnalyzer;
beforeEach(() => { analyzer = new ToolChainAnalyzer(); });

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
