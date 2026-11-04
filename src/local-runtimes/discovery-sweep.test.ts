// The sweep tells a runtime that is not there from one it got no answer from:
// a "no" with the probe's deadline spent is inconclusive, not absence. At
// boot the first sweep found no Ollama in 4.3 s without reaching it (2026-11-03).
import { describe, expect, it, vi } from "vitest";
import type { CandidateEndpoint } from "./endpoints.js";
import type { LocalRuntimeProbe } from "./types.js";

const fake = vi.hoisted(() => ({
  detect: async (_signal: AbortSignal) => false,
  listModels: async (_signal: AbortSignal) => [] as Array<{ id: string }>,
}));
vi.mock("./probes.js", () => ({
  LOCAL_RUNTIME_PROBES: [{
    kind: "ollama",
    label: "Ollama",
    defaultPorts: [11434],
    detect: (_ep: unknown, signal: AbortSignal) => fake.detect(signal),
    listModels: (_ep: unknown, signal: AbortSignal) => fake.listModels(signal),
    probeModel: async () => ({}),
  } as unknown as LocalRuntimeProbe],
}));

const { sweepCandidates } = await import("./discovery.js");
const CANDIDATE: CandidateEndpoint = { endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" }, kind: null };
/** Deadlines that never fire on their own; a fake probe spends one with abort(). */
const controllers: AbortController[] = [];
const deadline = () => { const c = new AbortController(); controllers.push(c); return c.signal; };
const spend = (signal: AbortSignal) => controllers.find((c) => c.signal === signal)?.abort();

describe("sweepCandidates", () => {
  it("a refused endpoint answers before its deadline: absent, not inconclusive", async () => {
    fake.detect = async () => false;
    expect(await sweepCandidates([CANDIDATE], deadline)).toEqual({ runtimes: [], inconclusive: [] });
  });

  it("a detect whose deadline ran out with no answer is inconclusive", async () => {
    fake.detect = async (signal) => { spend(signal); return false; };
    expect(await sweepCandidates([CANDIDATE], deadline)).toEqual({ runtimes: [], inconclusive: [CANDIDATE.endpoint.baseUrl] });
  });

  it("an empty model list that ran out of time is inconclusive too", async () => {
    fake.detect = async () => true;
    fake.listModels = async (signal) => { spend(signal); return []; };
    expect(await sweepCandidates([CANDIDATE], deadline)).toEqual({ runtimes: [], inconclusive: [CANDIDATE.endpoint.baseUrl] });
  });

  it("a runtime that answers is found", async () => {
    fake.detect = async () => true;
    fake.listModels = async () => [{ id: "qwen3.8:27b-172k" }];
    const sweep = await sweepCandidates([CANDIDATE], deadline);
    expect(sweep.inconclusive).toEqual([]);
    expect(sweep.runtimes.map((r) => r.models.map((m) => m.id))).toEqual([["qwen3.8:27b-172k"]]);
  });
});
