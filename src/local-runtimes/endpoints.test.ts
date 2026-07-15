import { describe, it, expect, vi } from "vitest";

import { candidateEndpoints, manualAllowlist, manualRuntimeEntries } from "./endpoints.js";

vi.mock("../config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434" }),
}));
vi.mock("../settings.js", () => ({
  loadSettings: () => ({}),
}));

describe("manualRuntimeEntries", () => {
  it("validates structurally — malformed entries skipped, never thrown on", () => {
    const settings = {
      localRuntimes: [
        { kind: "openai-compat", baseUrl: "http://127.0.0.1:1234/", label: "LM Studio" },
        { kind: "bogus-kind", baseUrl: "http://127.0.0.1:9" },
        { kind: "ollama", baseUrl: "not a url" },
        "garbage",
        null,
      ],
    };
    expect(manualRuntimeEntries(settings)).toEqual([
      { kind: "openai-compat", baseUrl: "http://127.0.0.1:1234", label: "LM Studio" },
    ]);
  });

  it("[] when localRuntimes is absent or not an array", () => {
    expect(manualRuntimeEntries({})).toEqual([]);
    expect(manualRuntimeEntries({ localRuntimes: "x" })).toEqual([]);
  });
});

describe("manualAllowlist", () => {
  it("is the exact host:port set of manual entries", () => {
    const settings = {
      localRuntimes: [{ kind: "openai-compat", baseUrl: "http://192.168.1.50:8000" }],
    };
    expect([...manualAllowlist(settings)]).toEqual(["192.168.1.50:8000"]);
  });
});

describe("candidateEndpoints", () => {
  it("sweeps known loopback ports with no settings at all", () => {
    const cands = candidateEndpoints({});
    const urls = cands.map((c) => c.endpoint.baseUrl);
    expect(urls).toContain("http://127.0.0.1:11434");
    // every auto candidate is loopback
    for (const c of cands) expect(c.endpoint.baseUrl).toMatch(/127\.0\.0\.1/);
  });

  it("manual entry wins the host:port dedupe and keeps kind + label", () => {
    const cands = candidateEndpoints({
      localRuntimes: [{ kind: "ollama", baseUrl: "http://127.0.0.1:11434", label: "My Ollama" }],
    });
    const at11434 = cands.filter((c) => c.endpoint.baseUrl.includes(":11434"));
    expect(at11434).toHaveLength(1);
    expect(at11434[0]).toMatchObject({
      kind: "ollama",
      label: "My Ollama",
      endpoint: { origin: "manual" },
    });
  });

  it("manual non-loopback entries are admitted via their own allowlist entry", () => {
    const cands = candidateEndpoints({
      localRuntimes: [{ kind: "openai-compat", baseUrl: "http://192.168.1.50:8000" }],
    });
    expect(cands.some((c) => c.endpoint.baseUrl === "http://192.168.1.50:8000")).toBe(true);
  });
});
