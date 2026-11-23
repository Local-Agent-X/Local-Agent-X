// What GET /api/health/providers serves: each provider's static profile. It
// used to also report a live concurrency and circuit state that nothing ever
// updated, so it always read "full capacity, circuit closed" (removed
// 2026-11-23).
import { describe, expect, it } from "vitest";
import { bootstrapProviderMatrix, providerProfiles, resourceLocksForProvider } from "./provider-matrix.js";

describe("provider profiles", () => {
  bootstrapProviderMatrix();

  it("lists every provider with its ceiling and locks, and nothing that claims to be live", () => {
    const profiles = providerProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(6);
    const local = profiles.find((p) => p.id === "localHttpOllama");
    expect(local).toEqual({ id: "localHttpOllama", label: "Local model (Ollama)", maxConcurrent: 1, resourceLocks: ["gpu:0"] });
    for (const p of profiles) {
      expect(Object.keys(p).sort()).toEqual(["id", "label", "maxConcurrent", "resourceLocks"]);
    }
  });

  it("hands out copies: a caller cannot change the locks the scheduler reads", () => {
    providerProfiles().find((p) => p.id === "localHttpOllama")!.resourceLocks.push("gpu:1");
    expect(resourceLocksForProvider("local")).toEqual(["gpu:0"]);
  });
});
