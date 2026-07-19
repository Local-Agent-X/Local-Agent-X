import { describe, expect, it, vi } from "vitest";
import { certificationFingerprint } from "./certification-fingerprint.js";
import {
  hasPublishedCertification,
  restorePublishedCertification,
  restorePublishedCertifications,
} from "./certification-runner.js";
import { CERTIFICATION_SCENARIOS, type LocalModelCertification } from "./certification-types.js";
import type { LocalRuntimeInfo } from "./types.js";

const identity = { runtimeVersion: "0.32.0", modelDigest: "sha256:model-a" };

function runtime(): LocalRuntimeInfo {
  return {
    kind: "ollama",
    id: "ollama@127.0.0.1:11434",
    label: "Ollama",
    endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" },
    chatBaseUrl: "http://127.0.0.1:11434/v1",
    models: [{ id: "model-a", contextWindow: 8192, tools: true }],
    refreshedAt: 1,
  };
}

function passing(runtimeInfo: LocalRuntimeInfo): LocalModelCertification {
  const scenarios = Object.fromEntries(CERTIFICATION_SCENARIOS.map((id) => [id, {
    passed: true, calls: 1, latencyMs: 1, failure: null,
  }])) as LocalModelCertification["scenarios"];
  return {
    version: 1,
    fingerprint: certificationFingerprint(runtimeInfo, "model-a", identity),
    scenarios,
    passedCount: CERTIFICATION_SCENARIOS.length,
    callCount: CERTIFICATION_SCENARIOS.length,
    totalLatencyMs: CERTIFICATION_SCENARIOS.length,
  };
}

describe("persisted certification restoration", () => {
  it("republishes exact cached Ollama evidence after identity validation only", async () => {
    const current = runtime();
    const cached = passing(current);
    const read = vi.fn(() => cached);
    const resolveIdentity = vi.fn(async (
      _runtime: LocalRuntimeInfo,
      _model: string,
      _signal: AbortSignal,
    ) => identity);

    expect(await restorePublishedCertification({ runtime: current, model: "model-a" }, {
      store: { read }, resolveIdentity,
    })).toBe(true);
    expect(resolveIdentity).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(cached.fingerprint.hash);
    expect(hasPublishedCertification(current, current.models[0]!)).toBe(true);
  });

  it("publishes nothing for misses, partial/corrupt evidence, or unknown identity", async () => {
    const cases = [
      { read: () => null, identity },
      { read: () => ({ ...passing(runtime()), passedCount: 4 }), identity },
      { read: () => ({
        ...passing(runtime()),
        passedCount: 4,
        scenarios: {
          ...passing(runtime()).scenarios,
          baseline_marker: { passed: false, calls: 1, latencyMs: 1, failure: "missing_marker" as const },
        },
      }), identity },
      { read: () => { throw new Error("corrupt"); }, identity },
      { read: vi.fn(() => passing(runtime())), identity: { ...identity, modelDigest: null } },
    ];
    for (const entry of cases) {
      const current = runtime();
      expect(await restorePublishedCertification({ runtime: current, model: "model-a" }, {
        store: { read: entry.read },
        resolveIdentity: async () => entry.identity,
      })).toBe(false);
      expect(hasPublishedCertification(current, current.models[0]!)).toBe(false);
      if (entry.identity.modelDigest === null) expect(entry.read).not.toHaveBeenCalled();
    }
  });

  it("carries refresh publication only across an exact selection and identity", async () => {
    const previous = runtime();
    previous.models.push({ id: "model-b", contextWindow: 4096, tools: true });
    const cached = passing(previous);
    const deps = { store: { read: () => cached }, resolveIdentity: async () => identity };
    await restorePublishedCertification({ runtime: previous, model: "model-a" }, deps);

    const exact = runtime();
    exact.models.push({ id: "model-b", contextWindow: 4096, tools: true });
    const resolveIdentity = vi.fn(async (
      _runtime: LocalRuntimeInfo,
      _model: string,
      _signal: AbortSignal,
    ) => identity);
    expect(await restorePublishedCertifications([exact], [previous], {
      ...deps, resolveIdentity,
    })).toBe(1);
    expect(resolveIdentity).toHaveBeenCalledOnce();
    expect(resolveIdentity.mock.calls[0]?.[1]).toBe("model-a");
    expect(hasPublishedCertification(exact, exact.models[0]!)).toBe(true);

    const drifts = [
      { ...runtime(), kind: "openai-compat" as const },
      { ...runtime(), endpoint: { ...runtime().endpoint, baseUrl: "http://127.0.0.1:11435" } },
      { ...runtime(), chatBaseUrl: "http://127.0.0.1:11434/other" },
      { ...runtime(), models: [{ id: "model-b", contextWindow: 8192, tools: true }] },
      { ...runtime(), models: [{ id: "model-a", contextWindow: 4096, tools: true }] },
      { ...runtime(), models: [{ id: "model-a", contextWindow: 8192, tools: false }] },
    ];
    for (const drift of drifts) {
      expect(await restorePublishedCertifications([drift], [previous], deps)).toBe(0);
      expect(hasPublishedCertification(drift, drift.models[0]!)).toBe(false);
    }
    for (const changed of [
      { ...identity, runtimeVersion: "0.33.0" },
      { ...identity, modelDigest: "sha256:model-b" },
    ]) {
      const current = runtime();
      expect(await restorePublishedCertifications([current], [previous], {
        ...deps, resolveIdentity: async () => changed,
      })).toBe(0);
      expect(hasPublishedCertification(current, current.models[0]!)).toBe(false);
    }
  });
});
