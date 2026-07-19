import { describe, expect, it } from "vitest";
import { certificationFingerprint } from "./certification-fingerprint.js";
import { CERTIFICATION_SCENARIOS } from "./certification-types.js";
import type { LocalRuntimeInfo } from "./types.js";

const runtime: LocalRuntimeInfo = {
  kind: "ollama",
  id: "ollama@127.0.0.1:11434",
  label: "Ollama",
  endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" },
  chatBaseUrl: "http://127.0.0.1:11434/v1",
  models: [],
  refreshedAt: 1,
};

describe("certification fingerprint", () => {
  it("changes for every exact runtime/model identity dimension", () => {
    const base = certificationFingerprint(runtime, "model-a", {
      runtimeVersion: "1.0.0",
      modelDigest: "digest-a",
    });
    const variants = [
      certificationFingerprint({
        ...runtime,
        endpoint: { ...runtime.endpoint, baseUrl: "http://127.0.0.1:11435" },
      }, "model-a", { runtimeVersion: "1.0.0", modelDigest: "digest-a" }),
      certificationFingerprint({
        ...runtime,
        chatBaseUrl: "http://127.0.0.1:11434/other",
      }, "model-a", { runtimeVersion: "1.0.0", modelDigest: "digest-a" }),
      certificationFingerprint(runtime, "model-b", {
        runtimeVersion: "1.0.0", modelDigest: "digest-a",
      }),
      certificationFingerprint(runtime, "model-a", {
        runtimeVersion: "1.0.1", modelDigest: "digest-a",
      }),
      certificationFingerprint(runtime, "model-a", {
        runtimeVersion: "1.0.0", modelDigest: "digest-b",
      }),
    ];
    expect(base.reusable).toBe(true);
    expect(new Set(variants.map((entry) => entry.hash))).toHaveLength(5);
    expect(variants.every((entry) => entry.hash !== base.hash)).toBe(true);
  });

  it("normalizes only a trailing slash and marks any unknown identity non-reusable", () => {
    const withoutSlash = certificationFingerprint(runtime, "model-a", {
      runtimeVersion: "1.0.0", modelDigest: "digest-a",
    });
    const withSlash = certificationFingerprint({
      ...runtime,
      endpoint: { ...runtime.endpoint, baseUrl: `${runtime.endpoint.baseUrl}/` },
    }, "model-a", { runtimeVersion: "1.0.0", modelDigest: "digest-a" });
    expect(withSlash.hash).toBe(withoutSlash.hash);
    expect(certificationFingerprint(runtime, "model-a", {
      runtimeVersion: null, modelDigest: "digest-a",
    }).reusable).toBe(false);
    expect(certificationFingerprint(runtime, "model-a", {
      runtimeVersion: "1.0.0", modelDigest: null,
    }).reusable).toBe(false);
  });
  it("binds reuse to the certification contract and current runtime capability profile", () => {
    const profiled = {
      ...runtime,
      models: [{ id: "model-a", contextWindow: 8192, tools: true }],
    };
    const identity = { runtimeVersion: "1.0.0", modelDigest: "digest-a" };
    const base = certificationFingerprint(profiled, "model-a", identity);
    const variants = [
      certificationFingerprint({ ...profiled, kind: "openai-compat" }, "model-a", identity),
      certificationFingerprint({
        ...profiled,
        models: [{ id: "model-a", contextWindow: 16384, tools: true }],
      }, "model-a", identity),
      certificationFingerprint({
        ...profiled,
        models: [{ id: "model-a", contextWindow: 8192, tools: false }],
      }, "model-a", identity),
      certificationFingerprint(profiled, "model-a", identity, {
        version: 2,
        scenarios: CERTIFICATION_SCENARIOS,
      }),
      certificationFingerprint(profiled, "model-a", identity, {
        version: 1,
        scenarios: CERTIFICATION_SCENARIOS.slice(0, -1),
      }),
    ];
    expect(new Set(variants.map((entry) => entry.hash))).toHaveLength(5);
    expect(variants.every((entry) => entry.hash !== base.hash)).toBe(true);
  });
});

