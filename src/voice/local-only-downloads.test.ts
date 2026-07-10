import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => false };
});

import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import { ensureModelDownloaded } from "./stt-model-fetch.js";
import { ensureTTSModelDownloaded } from "./tts-model-fetch.js";
import { ensureVadModelDownloaded } from "./vad-model-fetch.js";
import { ensureWhisperModelDownloaded } from "./whisper-model-fetch.js";

let saved: LAXConfig;

describe("strict local-only voice model downloads", () => {
  beforeAll(() => {
    saved = getRuntimeConfig();
    setRuntimeConfig({ ...saved, localOnlyMode: true });
  });
  afterAll(() => setRuntimeConfig(saved));

  it("blocks every missing voice model before any remote fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(ensureModelDownloaded()).rejects.toThrow(/local-only/i);
    await expect(ensureTTSModelDownloaded()).rejects.toThrow(/local-only/i);
    await expect(ensureVadModelDownloaded()).rejects.toThrow(/local-only/i);
    await expect(ensureWhisperModelDownloaded()).rejects.toThrow(/local-only/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
