// @vitest-environment happy-dom
//
// The Local (no GPU) voice tier: in-process Kokoro on the CPU plus Parakeet
// speech recognition, no sidecar. Saved in-process Kokoro settings show as
// Local again (they had been shown as Studio, which needs the sidecar), and
// the tier card reports Parakeet's download from /status sttModels.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const js = (f: string) => readFileSync(join(__dirname, "../public/js", f), "utf8");
const source = [js("voice-picker-catalog.js"), js("voice-picker.js"), js("voice-picker-prereqs.js")].join("\n");

interface Picker {
  resolve: (saved: Record<string, unknown>) => string;
  check: (p: { kind: string }) => { ok: boolean; hint: string; action: string; actionLabel?: string };
  setStatus: (s: unknown) => void;
  tier: (id: string) => { settings: Record<string, string>; prerequisites: { kind: string }[] } | null;
}

let picker: Picker;
beforeEach(() => {
  picker = new Function(`${source}
    return {
      resolve: _resolveActiveTierId,
      check: _checkPrereq,
      setStatus: (s) => { _setupStatus = s; },
      tier: getTierById,
    };`)() as Picker;
});

describe("the Local (no GPU) tier", () => {
  it("runs Kokoro in-process with Parakeet, no sidecar", () => {
    const t = picker.tier("local")!;
    expect(t.settings).toMatchObject({
      voiceEngine: "tier4", voiceTier4Provider: "kokoro",
      voiceSttProvider: "local-whisper", voiceWhisperModel: "parakeet-v3",
    });
    expect(t.prerequisites.map(p => p.kind)).toEqual(["model:parakeet-v3", "npm:kokoro-js"]);
    expect(t.prerequisites.some(p => p.kind.startsWith("sidecar:"))).toBe(false);
  });

  it("saved in-process Kokoro settings show as Local, not Studio", () => {
    expect(picker.resolve({ voiceEngine: "tier4", voiceTier4Provider: "kokoro" })).toBe("local");
    expect(picker.resolve({ voiceEngine: "tier4" })).toBe("local");
    expect(picker.resolve(picker.tier("local")!.settings)).toBe("local");
  });

  it("other tiers still resolve to themselves", () => {
    expect(picker.resolve({ voiceEngine: "python" })).toBe("studio");
    expect(picker.resolve({ voiceEngine: "tier4", voiceTier4Provider: "edge-tts" })).toBe("edge");
  });
});

describe("the Parakeet prerequisite row", () => {
  const row = (m: Record<string, unknown>) => {
    picker.setStatus({ tiers: [], sttModels: { "parakeet-v3": { cached: false, downloading: false, overallPct: 0, ...m } } });
    return picker.check({ kind: "model:parakeet-v3" });
  };

  it("offers a Download when it isn't on disk", () => {
    expect(row({})).toMatchObject({ ok: false, hint: "Not downloaded", action: "download-model", actionLabel: "Download" });
  });

  it("shows progress while it downloads", () => {
    expect(row({ downloading: true, overallPct: 42 })).toMatchObject({ ok: false, hint: "Downloading 42%", action: "none" });
  });

  it("offers a Retry after a failed download", () => {
    expect(row({ error: "HTTP 503" })).toMatchObject({ ok: false, hint: "Download failed", action: "download-model", actionLabel: "Retry" });
  });

  it("is ready once downloaded", () => {
    expect(row({ cached: true })).toMatchObject({ ok: true, hint: "Downloaded" });
  });
});

describe("the Kokoro prerequisite row", () => {
  it("is ready before the voices are cached — the first reply fetches them", () => {
    picker.setStatus({ tiers: [{ id: "native", installed: true, healthPayload: { modelCached: false } }] });
    expect(picker.check({ kind: "npm:kokoro-js" })).toMatchObject({ ok: true, hint: "Downloads on first use" });
  });
});
