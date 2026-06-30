import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BEHAVIORAL proof of the F4 dedup's central claim: routing settings writes
// through the canonical module (saveSettings/setSetting) preserves sibling keys
// and writes atomically — i.e. a sidebar-pin write can NOT clobber `provider`,
// `port`, etc. (the lax-settings-clobber hazard). The settings-io-contract lock
// is STRUCTURAL (no new raw I/O); this is the FUNCTIONAL net that the fold itself
// behaves. Module reads getLaxDir() at load, so set LAX_DATA_DIR before import.

let settings: typeof import("./settings.js");
let laxDir: string;
let saved: string | undefined;

beforeAll(async () => {
  saved = process.env.LAX_DATA_DIR;
  laxDir = mkdtempSync(join(tmpdir(), "settings-clobber-"));
  process.env.LAX_DATA_DIR = laxDir;
  // Pre-seed a settings.json carrying machine-specific keys that MUST survive a
  // UI-state write — exactly the keys the old raw writers risked dropping.
  writeFileSync(
    join(laxDir, "settings.json"),
    JSON.stringify({ provider: "anthropic", port: 8765, voiceTier4Device: "mic-2", sidebarPins: [] }),
  );
  settings = await import("./settings.js");
  settings.reloadSettings(); // discard any cache from a prior suite
});

afterAll(() => {
  if (saved === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = saved;
  rmSync(laxDir, { recursive: true, force: true });
});

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(laxDir, "settings.json"), "utf-8"));
}

describe("F4 settings clobber-safety (the fold's central claim)", () => {
  it("setSetting('sidebarPins', …) keeps every sibling key on disk", () => {
    settings.setSetting("sidebarPins", [{ name: "Calc", icon: "🧮", url: "/apps/calc/" }]);
    const disk = onDisk();
    expect(disk.sidebarPins).toEqual([{ name: "Calc", icon: "🧮", url: "/apps/calc/" }]);
    // The keys a raw `writeFileSync({sidebarPins})` would have dropped:
    expect(disk.provider).toBe("anthropic");
    expect(disk.port).toBe(8765);
    expect(disk.voiceTier4Device).toBe("mic-2");
  });

  it("saveSettings(reloadSettings()+mutate) — the sidebar pin path — preserves siblings", () => {
    const s = settings.reloadSettings();
    (s.sidebarPins as unknown[]).push({ name: "Notes", icon: "📝", url: "/apps/notes/" });
    settings.saveSettings(s);
    const disk = onDisk();
    expect((disk.sidebarPins as unknown[]).length).toBe(2);
    expect(disk.provider).toBe("anthropic");
    expect(disk.port).toBe(8765);
  });

  it("the cache stays coherent after a write (what /api/apps reads), no manual reload", () => {
    settings.setSetting("sidebarPins", []);
    // loadSettings() returns the cache — must reflect the write that just happened.
    expect(settings.loadSettings().sidebarPins).toEqual([]);
    expect(settings.getSetting("provider")).toBe("anthropic");
  });
});
