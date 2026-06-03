// @vitest-environment happy-dom
//
// Unit test for the PURE render functions of the Settings → Security "Audit
// Log" panel (public/js/settings-audit-log.js). The module is browser-global
// (bare function declarations + window exposure). We execute the source in a
// fresh function scope per test and pull renderAuditEntries / renderAuditSummary
// off window. Fields asserted mirror the real AuditEntry/AuditSummary shapes in
// src/ari-kernel/audit-viewer.ts.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

interface AuditEntry {
  seq: number;
  timestamp: string;
  event: string;
  toolName?: string;
  decision: string;
  reason: string;
  role?: string;
  threatLevel?: string;
}

interface Renderers {
  renderAuditEntries(entries: AuditEntry[]): string;
  renderAuditSummary(summary: unknown): string;
}

let R: Renderers;

beforeEach(() => {
  const src = readFileSync(join(here, "../public/js/settings-audit-log.js"), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(src)();
  R = (globalThis as unknown as { window: Renderers }).window;
});

describe("renderAuditEntries", () => {
  it("renders real audit fields and escapes HTML-bearing strings", () => {
    const entries: AuditEntry[] = [
      {
        seq: 7,
        timestamp: "2026-06-03T12:00:00.000Z",
        event: "tool_call",
        toolName: "bash",
        decision: "block",
        reason: "blocked <script>alert(1)</script> & friends",
        role: "agent",
        threatLevel: "high",
      },
    ];
    const html = R.renderAuditEntries(entries);
    expect(html).toContain("#7");
    expect(html).toContain("tool_call");
    expect(html).toContain("bash");
    expect(html).toContain("block");
    expect(html).toContain("agent");
    expect(html).toContain("high");
    // The dangerous string is escaped, not present raw.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; friends");
  });

  it("renders the empty-state message for an empty array", () => {
    expect(R.renderAuditEntries([])).toContain("No audit entries yet.");
  });
});

describe("renderAuditSummary", () => {
  it("renders totals and per-decision counts", () => {
    const html = R.renderAuditSummary({
      totalEntries: 12,
      decisions: { allow: 9, block: 3 },
      topTools: [],
      topEvents: [],
      threatLevelDistribution: {},
    });
    expect(html).toContain("12 entries");
    expect(html).toContain("allow: 9");
    expect(html).toContain("block: 3");
  });

  it("renders nothing for an empty summary", () => {
    expect(R.renderAuditSummary({ totalEntries: 0, decisions: {} })).toBe("");
  });
});
