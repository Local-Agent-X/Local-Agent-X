import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Guards the two hardening steps added 2026-07-25.
//
// 1. The voice tier installs from a COMPILED LOCK, not requirements.txt.
//    requirements.txt pins only direct deps; every transitive was resolved
//    fresh at install time. That is how huggingface_hub 1.x got in, dropped
//    `requests` (which faster_whisper imports at module scope), and left a venv
//    that pip called a success and the picker called "Installed" — right up
//    until the sidecar crashed on import. The lock closes the class.
//
// 2. Studio (chatterbox) and Studio-Vox (voxcpm) had NO pins at all — bare
//    `pip install voxcpm faster-whisper ...`, so every install took whatever
//    PyPI served that day. They now have pinned requirements.txt files.
//
// These are static checks: no network, so they run in the gate.

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(repoFile(rel), "utf8");

/** Package names pinned with `==` at the start of a line. */
function pinnedNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const m = line.match(/^([A-Za-z0-9._-]+)(?:\[[^\]]+\])?\s*==/);
    if (m) out.add(m[1].toLowerCase().replace(/_/g, "-"));
  }
  return out;
}

describe.each([
  ["windows", "python/voice/requirements.txt", "python/voice/requirements.lock"],
  ["macos", "python/voice/requirements-mac.txt", "python/voice/requirements-mac.lock"],
])("voice %s lock", (_platform, srcRel, lockRel) => {
  it("exists — the installer reads the lock, so a missing one breaks install", () => {
    expect(existsSync(repoFile(lockRel))).toBe(true);
  });

  it("covers every direct dependency declared in the source file", () => {
    const src = pinnedNames(read(srcRel));
    const lock = pinnedNames(read(lockRel));
    // requirements.txt uses range specs for a few pins (huggingface_hub,
    // requests, numpy), so compare only the names it pins with ==.
    for (const name of src) {
      expect(lock.has(name), `${name} is in ${srcRel} but missing from the lock`).toBe(true);
    }
  });

  it("pins strictly more than the source — i.e. it actually locked transitives", () => {
    const src = pinnedNames(read(srcRel));
    const lock = pinnedNames(read(lockRel));
    expect(lock.size).toBeGreaterThan(src.size);
  });

  it("pins huggingface-hub below 1.0 — the exact transitive that broke the tier", () => {
    const lock = read(lockRel);
    const m = lock.match(/^huggingface-hub==(\d+)\.(\d+)/m);
    expect(m, "huggingface-hub must be pinned in the lock").toBeTruthy();
    expect(Number(m![1]), "hub 1.x drops requests and breaks faster_whisper").toBe(0);
    expect(pinnedNames(lock).has("requests")).toBe(true);
  });

  it("is hash-verified", () => {
    expect(read(lockRel)).toMatch(/--hash=sha256:/);
  });
});

describe.each([
  ["chatterbox", "python/chatterbox/requirements.txt", ["chatterbox-streaming"]],
  ["voxcpm", "python/voxcpm/requirements.txt", ["voxcpm", "faster-whisper"]],
])("%s pins", (tier, rel, tierPackages) => {
  const pins = pinnedNames(read(rel));

  it("pins the tier's own engine packages", () => {
    for (const pkg of tierPackages) {
      expect(pins.has(pkg), `${pkg} must be pinned for ${tier}`).toBe(true);
    }
  });

  it("pins the server deps the sidecar imports at boot", () => {
    for (const pkg of ["fastapi", "uvicorn", "soundfile", "setuptools"]) {
      expect(pins.has(pkg), `${pkg} must be pinned for ${tier}`).toBe(true);
    }
  });

  it("does NOT pin torch — the +cu128 build is Windows-only and would break install.sh", () => {
    // Windows force-reinstalls torch from the pytorch cu128 index (Blackwell
    // needs it); macOS/Linux take the CPU/MPS build upstream resolves. A
    // +cu128 pin in this shared file has no macOS wheel.
    expect(pins.has("torch")).toBe(false);
    expect(pins.has("torchaudio")).toBe(false);
  });

  it("leaves no floating installs in the tier's installers", () => {
    // The whole point of this pass: every dependency install must come from the
    // requirements file, not a bare package list on the command line.
    for (const script of [`python/${tier}/install.ps1`, `python/${tier}/install.sh`]) {
      const text = read(script);
      const floating = text
        .split(/\r?\n/)
        .filter(l => /uv[^\n]*pip install/.test(l) && !/-r\s/.test(l) && !/--reinstall/.test(l));
      expect(floating, `${script} still installs unpinned packages: ${floating.join(" | ")}`).toEqual([]);
    }
  });
});

describe("cu128 torch override stays pinned", () => {
  it.each(["python/chatterbox/install.ps1", "python/voxcpm/install.ps1"])(
    "%s pins the torch pair rather than floating",
    (rel) => {
      const text = read(rel);
      // A bare `--reinstall torch torchaudio` would re-float the single most
      // expensive dependency in the tier on every reinstall.
      expect(text).toMatch(/\$TorchPin\s*=\s*@\(\s*"torch==\d+\.\d+\.\d+\+cu128"/);
      expect(text).toMatch(/--reinstall \$TorchPin/);
      expect(text).not.toMatch(/--reinstall torch torchaudio/);
    },
  );
});
