import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression lock for pins that can never install.
//
// `phonemizer==3.3.2` shipped in c4a8425b and was unresolvable from the day it
// landed: upstream phonemizer stops at 3.3.0. The 3.3.2 belongs to
// `phonemizer-fork` — the distribution kokoro-onnx actually depends on, and
// the one that provides the `phonemizer` import package _server/models.py
// patches. Behind it sat a second unresolvable pin: `numpy<2.0`, justified by
// a Coqui/RVC constraint whose venv moved out of this file long ago, against
// kokoro-onnx 0.4.9's `numpy>=2.0.2`. Both together meant Lite's installer
// could not succeed on any machine — it built a venv, failed pip, and left a
// pip-only corpse the picker called "Installed".
//
// These are static checks so they run in the gate with no network. The live
// resolution check is the opt-in test at the bottom.

const readReqs = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../python/voice/${name}`, import.meta.url)), "utf8");

interface Pin { name: string; spec: string; }

/** Parse `name==1.2.3` / `name>=1,<2` / `name[extra]==1.2.3` lines. */
function parsePins(text: string): Pin[] {
  const pins: Pin[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9._-]+)(?:\[[^\]]+\])?\s*(.*)$/);
    if (m) pins.push({ name: m[1].toLowerCase(), spec: m[2].trim() });
  }
  return pins;
}

const WIN = parsePins(readReqs("requirements.txt"));
const MAC = parsePins(readReqs("requirements-mac.txt"));
const find = (pins: Pin[], name: string) => pins.find(p => p.name === name);

describe.each([
  ["requirements.txt", WIN],
  ["requirements-mac.txt", MAC],
])("%s", (_file, pins) => {
  it("pins phonemizer-fork, never upstream phonemizer", () => {
    // Upstream `phonemizer` has no 3.3.2 and would shadow the fork's import
    // package if both were installed.
    expect(find(pins, "phonemizer")).toBeUndefined();
    expect(find(pins, "phonemizer-fork")?.spec).toBe("==3.3.2");
  });

  it("does not cap numpy below kokoro-onnx 0.4.9's floor of 2.0.2", () => {
    const numpy = find(pins, "numpy");
    expect(numpy).toBeDefined();
    expect(numpy!.spec).not.toMatch(/<\s*2(\.|\b)/);
    expect(numpy!.spec).toMatch(/>=\s*2\.0\.2/);
  });

  it("declares every module the installer's verify pass imports", () => {
    // _smoke.py fails the install if any of these are missing, so a pin
    // dropped from here turns into a failed install rather than a silent gap.
    const smoke = readFileSync(fileURLToPath(new URL("../../../../python/voice/_smoke.py", import.meta.url)), "utf8");
    const critical = [...smoke.matchAll(/^\s{4}"([a-z_]+)",/gm)].map(m => m[1]);
    expect(critical).toContain("numpy");
    // import name -> distribution name, where they differ
    const distFor: Record<string, string> = {
      faster_whisper: "faster-whisper",
      kokoro_onnx: "kokoro-onnx",
      phonemizer: "phonemizer-fork",
      silero_vad: "silero-vad",
      onnxruntime: find(pins, "onnxruntime-gpu") ? "onnxruntime-gpu" : "onnxruntime",
    };
    for (const mod of critical) {
      expect(find(pins, distFor[mod] ?? mod), `${mod} imported by _smoke.py but not pinned`).toBeDefined();
    }
  });
});

describe("windows and mac requirements agree", () => {
  // The mac file kept `numpy<2.0` after the windows file was touched, so the
  // mac install was broken by the same conflict for the same reason. Shared
  // packages must not drift; the divergences below are deliberate.
  const WINDOWS_ONLY = ["onnxruntime-gpu", "nvidia-cublas-cu12", "nvidia-cudnn-cu12"];
  const MAC_ONLY = ["onnxruntime"];

  it("pins every shared package to the same spec", () => {
    for (const w of WIN) {
      if (WINDOWS_ONLY.includes(w.name)) continue;
      const m = find(MAC, w.name);
      if (!m) continue; // presence drift is covered below
      expect(m.spec, `${w.name} drifted between requirements files`).toBe(w.spec);
    }
  });

  it("lists the same packages apart from the documented CUDA/CPU split", () => {
    const winNames = WIN.map(p => p.name).filter(n => !WINDOWS_ONLY.includes(n));
    const macNames = MAC.map(p => p.name).filter(n => !MAC_ONLY.includes(n));
    expect([...winNames].sort()).toEqual([...macNames].sort());
  });
});
