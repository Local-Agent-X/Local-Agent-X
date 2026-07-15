import { describe, it, expect, vi, afterEach } from "vitest";
import { discoverLocalRuntimes } from "./discovery.js";
import type { CandidateEndpoint } from "./endpoints.js";

// Absent the test-env guard in discoverLocalRuntimes(), this candidate would
// drive the probe layer to fetch its loopback endpoint. The fetch spy is the
// tripwire: if the sweep ever stops short-circuiting under vitest, it fires
// live network I/O and this test catches it. Guards against reintroducing the
// "passes on my machine (Ollama running) but not in CI" flake class.
const CANDIDATE: CandidateEndpoint = {
  endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" },
  kind: null,
};

describe("discoverLocalRuntimes test-env guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does no network I/O and returns [] under vitest", async () => {
    // mockRejected so that even a regression (guard removed) can't open a real
    // socket — the assertion below, not a real ECONNREFUSED, is what fails.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network blocked in test"));

    const result = await discoverLocalRuntimes([CANDIDATE]);

    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
