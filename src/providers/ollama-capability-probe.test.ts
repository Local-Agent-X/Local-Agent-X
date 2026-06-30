/**
 * ollama-capability-probe tests — the day-one capability probe and its
 * safety gates (only records a clear no-tool fact; never throws; probes once).
 *
 * fetch is stubbed so the /api/show round-trip is deterministic; the store
 * runs against a throwaway LAX_DATA_DIR. Each test uses a unique model name so
 * the in-memory once-per-process probe guard never bleeds across tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeOllamaCapabilities } from "./ollama-capability-probe.js";
import { hasNoTools, _resetForTests } from "./model-capabilities-store.js";

const BASE = "http://localhost:11434/v1";

function mockShow(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: async () => body });
}

let dir: string;
const prevEnv = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-probe-"));
  process.env.LAX_DATA_DIR = dir;
  _resetForTests();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  _resetForTests();
  vi.unstubAllGlobals();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("probeOllamaCapabilities", () => {
  it("records noTools when /api/show capabilities lack 'tools'", async () => {
    const f = mockShow({ capabilities: ["completion"] });
    vi.stubGlobal("fetch", f);
    await probeOllamaCapabilities(BASE, "qwen2:7b");
    expect(hasNoTools(BASE, "qwen2:7b")).toBe(true);
    // Hits the native root, not the OpenAI-compat /v1 path.
    expect(f.mock.calls[0][0]).toBe("http://localhost:11434/api/show");
  });

  it("does NOT record when the model declares tool support", async () => {
    vi.stubGlobal("fetch", mockShow({ capabilities: ["completion", "tools"] }));
    await probeOllamaCapabilities(BASE, "tooly-llama");
    expect(hasNoTools(BASE, "tooly-llama")).toBe(false);
  });

  it("does nothing on an absent/empty capability list (older Ollama)", async () => {
    vi.stubGlobal("fetch", mockShow({}));
    await probeOllamaCapabilities(BASE, "ancient-model");
    expect(hasNoTools(BASE, "ancient-model")).toBe(false);
  });

  it("never throws and records nothing on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(probeOllamaCapabilities(BASE, "unreachable")).resolves.toBeUndefined();
    expect(hasNoTools(BASE, "unreachable")).toBe(false);
  });

  it("does nothing on a non-OK response", async () => {
    vi.stubGlobal("fetch", mockShow({ capabilities: ["completion"] }, false));
    await probeOllamaCapabilities(BASE, "server-500");
    expect(hasNoTools(BASE, "server-500")).toBe(false);
  });

  it("probes a given (baseURL, model) only once per process", async () => {
    const f = mockShow({ capabilities: ["completion"] });
    vi.stubGlobal("fetch", f);
    await probeOllamaCapabilities(BASE, "once-model");
    await probeOllamaCapabilities(BASE, "once-model");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
