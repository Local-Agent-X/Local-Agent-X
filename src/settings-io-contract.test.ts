import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import fg from "fast-glob";

// CLASS LOCK for the settings.json I/O seam (see the lax-settings-clobber memory
// + the 2026-06-29 dedup that routed ~10 sites through the canonical module).
//
// The canonical reader/writer is src/settings.ts: loadSettings/getSetting (cached
// parse-once) and saveSettings/setSetting (atomic, mode-0600, cache-coherent). A
// module that hand-rolls `join(dataDir,"settings.json")` + raw readFileSync/
// writeFileSync re-introduces BOTH failure modes the dedup closed:
//   (a) the partial-object CLOBBER class — a raw write of a slice drops sibling
//       keys, and a non-atomic write can corrupt on crash; and
//   (b) a cache split-brain — a raw read sees a different value than every other
//       reader going through loadSettings()'s cache.
//
// This fails the moment a NEW module does raw settings.json I/O, so the class
// can't regress one site at a time. A genuine exception goes in ALLOWLIST with a
// reason.

const BUILDS_SETTINGS_PATH = /join\([^)]*["']settings\.json["']\)/;
const RAW_FS_IO = /\b(readFileSync|writeFileSync)\s*\(/;

const ALLOWLIST: Record<string, string> = {
  // The canonical reader/writer itself.
  "src/settings.ts": "the canonical settings module",
  // cron keeps its OWN settings.json under <dataDir>/cron/ — a different file,
  // not the LAX user settings.
  "src/cron/cron-service.ts": "cron's own cronDir/settings.json, not LAX settings",
  // Deliberate ephemeral 0600 probe seed: writes a minimal {provider} to a
  // throwaway sandbox dataDir that's deleted in the caller's finally — must NOT
  // touch the real cache/file.
  "src/self-edit/sandbox-gates.ts": "ephemeral self-edit probe seed, not the real settings",
};

describe("settings.json I/O class lock", () => {
  it("only the canonical settings module does raw settings.json I/O", async () => {
    const files = await fg("src/**/*.ts", { ignore: ["**/*.test.ts"] });
    const violations: string[] = [];
    for (const file of files.sort()) {
      if (file in ALLOWLIST) continue;
      const src = readFileSync(file, "utf8");
      if (BUILDS_SETTINGS_PATH.test(src) && RAW_FS_IO.test(src)) violations.push(file);
    }
    expect(violations, violations.length
      ? `These modules do raw settings.json I/O instead of going through src/settings.ts ` +
        `(use loadSettings/getSetting/saveSettings/setSetting, or add to ALLOWLIST with a reason):\n  ` +
        violations.join("\n  ")
      : "ok",
    ).toEqual([]);
  });

  it("the allowlisted exceptions still exist (no stale entries)", async () => {
    const files = new Set(await fg("src/**/*.ts"));
    for (const f of Object.keys(ALLOWLIST)) expect(files.has(f), `stale allowlist entry: ${f}`).toBe(true);
  });
});
