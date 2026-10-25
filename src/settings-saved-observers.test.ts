// Every settings write goes through saveSettings; a module whose running work
// depends on a setting hears the change here, with the new and previous
// values, instead of each writer remembering to tell it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-settings-observers-"));
process.env.LAX_DATA_DIR = dataDir;

const { onSettingsSaved, saveSettings, setSetting, loadSettings } = await import("./settings.js");

const unsubscribes: Array<() => void> = [];
afterEach(() => { while (unsubscribes.length) unsubscribes.pop()!(); });

describe("onSettingsSaved", () => {
  it("hears every write with the new and previous settings", () => {
    const seen = vi.fn();
    unsubscribes.push(onSettingsSaved(seen));
    saveSettings({ ...loadSettings(), developer_mode: true });
    setSetting("developer_mode", false);
    expect(seen).toHaveBeenCalledTimes(2);
    const [next, prev] = seen.mock.calls[1] as [Record<string, unknown>, Record<string, unknown>];
    expect(prev.developer_mode).toBe(true);
    expect(next.developer_mode).toBe(false);
  });

  it("an unsubscribed observer hears nothing more", () => {
    const seen = vi.fn();
    const off = onSettingsSaved(seen);
    off();
    setSetting("theme", "dark");
    expect(seen).not.toHaveBeenCalled();
  });

  it("a throwing observer neither breaks the write nor the observers after it", () => {
    const after = vi.fn();
    unsubscribes.push(onSettingsSaved(() => { throw new Error("observer bug"); }));
    unsubscribes.push(onSettingsSaved(after));
    setSetting("palette", "aurora");
    expect(loadSettings().palette).toBe("aurora");
    expect(after).toHaveBeenCalledTimes(1);
  });
});

process.on("exit", () => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});
