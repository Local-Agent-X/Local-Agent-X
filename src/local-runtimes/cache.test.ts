import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const restorePublishedCertifications = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./certification-runner.js", () => ({ restorePublishedCertifications }));

import {
  refreshLocalRuntimes,
  getLocalRuntimes,
  getLocalContextWindow,
  getLocalModelCapabilityProfile,
  getRuntimeForModel,
  invalidateLocalRuntimes,
  localRuntimesStale,
} from "./cache.js";
import type { LocalRuntimeInfo } from "./types.js";
import {
  _resetForTests,
  recordNoTools,
  recordToolsVerified,
} from "../providers/model-capabilities-store.js";

const RUNTIME: LocalRuntimeInfo = {
  kind: "ollama",
  id: "ollama@127.0.0.1:11434",
  label: "Ollama",
  endpoint: { baseUrl: "http://127.0.0.1:11434", origin: "auto" },
  chatBaseUrl: "http://127.0.0.1:11434/v1",
  models: [
    { id: "qwen3.6:27b", contextWindow: 32768, tools: true },
    { id: "mystery:latest", contextWindow: null, tools: null },
  ],
  refreshedAt: 0,
};

const SECOND_RUNTIME: LocalRuntimeInfo = {
  ...RUNTIME,
  kind: "openai-compat",
  id: "openai-compat@127.0.0.1:1234",
  label: "LM Studio",
  endpoint: { baseUrl: "http://127.0.0.1:1234", origin: "auto" },
  chatBaseUrl: "http://127.0.0.1:1234/v1",
};

vi.mock("./endpoints.js", () => ({ candidateEndpoints: () => [] }));
vi.mock("./discovery.js", () => ({
  discoverLocalRuntimes: vi.fn(async () => [RUNTIME]),
}));

let dataDir: string;
const previousDataDir = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-local-profile-"));
  process.env.LAX_DATA_DIR = dataDir;
  _resetForTests();
  invalidateLocalRuntimes();
  restorePublishedCertifications.mockClear();
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  _resetForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("local-runtime cache", () => {
  it("null before first refresh; populated + fresh after", async () => {
    expect(getLocalRuntimes()).toBeNull();
    expect(localRuntimesStale()).toBe(true);
    await refreshLocalRuntimes();
    expect(getLocalRuntimes()).toEqual([RUNTIME]);
    expect(localRuntimesStale()).toBe(false);
  });

  it("sync lookups: window by (chatBaseUrl, model); runtime by model", async () => {
    await refreshLocalRuntimes();
    expect(getLocalContextWindow("http://127.0.0.1:11434/v1", "qwen3.6:27b")).toBe(32768);
    // unknown window stays null — never an optimistic default
    expect(getLocalContextWindow("http://127.0.0.1:11434/v1", "mystery:latest")).toBeNull();
    expect(getLocalContextWindow("http://127.0.0.1:11434/v1", "absent")).toBeNull();
    expect(getRuntimeForModel("qwen3.6:27b")?.id).toBe("ollama@127.0.0.1:11434");
    expect(getRuntimeForModel("absent")).toBeNull();
  });

  it("coalesces concurrent refreshes into one sweep", async () => {
    const { discoverLocalRuntimes } = await import("./discovery.js");
    vi.mocked(discoverLocalRuntimes).mockClear();
    await Promise.all([refreshLocalRuntimes(), refreshLocalRuntimes(), refreshLocalRuntimes()]);
    expect(vi.mocked(discoverLocalRuntimes)).toHaveBeenCalledTimes(1);
    expect(restorePublishedCertifications).toHaveBeenCalledTimes(1);
  });

  it("schedules restore after discovery without awaiting it and passes the prior snapshot", async () => {
    let release!: () => void;
    restorePublishedCertifications.mockImplementationOnce(() => new Promise<number>((resolve) => {
      release = () => resolve(0);
    }));
    await refreshLocalRuntimes();
    expect(getLocalRuntimes()).toEqual([RUNTIME]);
    expect(restorePublishedCertifications).toHaveBeenLastCalledWith([RUNTIME], null);
    await refreshLocalRuntimes();
    expect(restorePublishedCertifications).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(restorePublishedCertifications).toHaveBeenCalledTimes(2));
    expect(restorePublishedCertifications).toHaveBeenLastCalledWith([RUNTIME], [RUNTIME]);
  });

  it("derives endpoint-isolated profiles for the same model id", async () => {
    const { discoverLocalRuntimes } = await import("./discovery.js");
    vi.mocked(discoverLocalRuntimes).mockResolvedValueOnce([RUNTIME, SECOND_RUNTIME]);
    recordToolsVerified(RUNTIME.chatBaseUrl, "qwen3.6:27b", true);
    recordNoTools(SECOND_RUNTIME.chatBaseUrl, "qwen3.6:27b");
    await refreshLocalRuntimes();

    expect(getLocalModelCapabilityProfile(RUNTIME.chatBaseUrl, "qwen3.6:27b")).toMatchObject({
      runtimeId: RUNTIME.id,
      baseURL: RUNTIME.chatBaseUrl,
      model: "qwen3.6:27b",
      tier: "medium",
      contextWindow: 32768,
      tools: { advertised: true, verified: true, rejectsTools: false },
    });
    expect(getLocalModelCapabilityProfile(SECOND_RUNTIME.chatBaseUrl, "qwen3.6:27b")).toMatchObject({
      runtimeId: SECOND_RUNTIME.id,
      baseURL: SECOND_RUNTIME.chatBaseUrl,
      tools: { advertised: true, verified: null, rejectsTools: true },
    });
  });

  it("keeps an unknown model conservative without disabling its tools", async () => {
    await refreshLocalRuntimes();
    const profile = getLocalModelCapabilityProfile(RUNTIME.chatBaseUrl, "unprobed-model");
    expect(profile).toEqual({
      runtimeId: RUNTIME.id,
      baseURL: RUNTIME.chatBaseUrl,
      model: "unprobed-model",
      tier: "medium",
      maxTools: expect.any(Number),
      contextWindow: null,
      tools: { advertised: null, verified: null, rejectsTools: false },
    });
    expect(profile.maxTools).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
