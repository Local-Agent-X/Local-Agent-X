// The sweep tells a runtime that is not there from one it could not ask: a
// "no" its probe's deadline rendered late, on a blocked loop, is inconclusive
// (deadline-verdict.ts), not absence.
import { describe, expect, it, vi } from "vitest";
import type { CandidateEndpoint } from "./endpoints.js";
import type { LocalRuntimeProbe } from "./types.js";

const clock = vi.hoisted(() => ({ t: 0 }));
const fake = vi.hoisted(() => ({
  detect: async () => false,
  listModels: async () => [] as Array<{ id: string }>,
}));
vi.mock("./probes.js", () => ({
  LOCAL_RUNTIME_PROBES: [{
    kind: "ollama",
    label: "Ollama",
    defaultPorts: [11434],
    detect: (...a: unknown[]) => fake.detect(...(a as [])),
    listModels: (...a: unknown[]) => fake.listModels(...(a as [])),
    probeModel: async () => ({}),
  } as unknown as LocalRuntimeProbe],
}));

const { sweepCandidates } = await import("./discovery.js");
const CANDIDATE: CandidateEndpoint = { endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" }, kind: null };
const now = () => clock.t;

describe("sweepCandidates", () => {
  it("a refused endpoint answers at once: absent, not inconclusive", async () => {
    fake.detect = async () => false;
    expect(await sweepCandidates([CANDIDATE], now)).toEqual({ runtimes: [], inconclusive: [] });
  });

  it("a detect deadline that fired seconds late is inconclusive", async () => {
    fake.detect = async () => { clock.t += 9_000; return false; };
    expect(await sweepCandidates([CANDIDATE], now)).toEqual({ runtimes: [], inconclusive: [CANDIDATE.endpoint.baseUrl] });
  });

  it("an empty model list that came back starved is inconclusive too", async () => {
    fake.detect = async () => true;
    fake.listModels = async () => { clock.t += 9_000; return []; };
    expect(await sweepCandidates([CANDIDATE], now)).toEqual({ runtimes: [], inconclusive: [CANDIDATE.endpoint.baseUrl] });
  });

  it("a runtime that answers is found", async () => {
    fake.detect = async () => true;
    fake.listModels = async () => [{ id: "qwen3.8:27b-172k" }];
    const sweep = await sweepCandidates([CANDIDATE], now);
    expect(sweep.inconclusive).toEqual([]);
    expect(sweep.runtimes.map((r) => r.models.map((m) => m.id))).toEqual([["qwen3.8:27b-172k"]]);
  });
});
