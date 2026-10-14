import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looseNameMatch, resolvePinToUnpin, sidebarUnpin } from "./sidebar.js";
import { reloadSettings, saveSettings } from "../../settings.js";
import { listTombstonedPinNames, pinTombstonePaths } from "../../sync/pin-tombstones.js";

describe("sidebar_unpin sync tombstones", () => {
  let dir: string;
  const prev = process.env.LAX_DATA_DIR;
  const tombstoned = () => listTombstonedPinNames(pinTombstonePaths(dir, join(dir, "sync-repo")));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-sidebar-"));
    process.env.LAX_DATA_DIR = dir;
    saveSettings({ sidebarPins: [
      { name: "Weather", icon: "☀", url: "/apps/weather/" },
      { name: "Calculator", icon: "🧮", url: "/apps/calculator/" },
    ] });
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prev;
    reloadSettings();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a tombstone for the removed pin so a sync pull cannot restore it", async () => {
    // The DELETE /api/sidebar/pins route tombstones; the tool only edited
    // settings.json, so a tool-removed pin came back on the next pull.
    const res = await sidebarUnpin.execute({ name: "weather" });
    expect(res.isError).toBeFalsy();
    expect((reloadSettings().sidebarPins as Array<{ name: string }>).map(p => p.name)).toEqual(["Calculator"]);
    expect([...tombstoned()]).toEqual(["Weather"]);
  });

  it("tombstones every pin when clearing all", async () => {
    await sidebarUnpin.execute({ name: "all" });
    expect([...tombstoned()].sort()).toEqual(["Calculator", "Weather"]);
  });
});

describe("looseNameMatch", () => {
  it("matches case-insensitively and on substring either way", () => {
    expect(looseNameMatch("Dinosaur Todo App", "dinosaur todo")).toBe(true);
    expect(looseNameMatch("dinosaur todo", "Dinosaur Todo App")).toBe(true);
    expect(looseNameMatch("Calculator", "calculator")).toBe(true);
  });

  it("does not match unrelated names", () => {
    expect(looseNameMatch("Calculator", "weather")).toBe(false);
  });
});

describe("resolvePinToUnpin", () => {
  const pins = ["Dinosaur Todo App", "Weather", "Calculator"];

  it("resolves a partial reference to the stored pin", () => {
    // The exact-match filter that shipped before returned no match here, so
    // unpin reported the app wasn't pinned when it was. It now resolves.
    expect(resolvePinToUnpin(pins, "dinosaur todo")).toEqual({ kind: "match", name: "Dinosaur Todo App" });
  });

  it("still resolves an exact name", () => {
    expect(resolvePinToUnpin(pins, "Weather")).toEqual({ kind: "match", name: "Weather" });
  });

  it("prefers the exact match over a longer pin that contains it", () => {
    expect(resolvePinToUnpin(["Todo", "Todo App"], "todo")).toEqual({ kind: "match", name: "Todo" });
  });

  it("reports ambiguity instead of guessing when a partial hits multiple pins", () => {
    expect(resolvePinToUnpin(["Todo App", "Todo Archive"], "todo")).toEqual({
      kind: "ambiguous",
      candidates: ["Todo App", "Todo Archive"],
    });
  });

  it("returns none when nothing matches", () => {
    expect(resolvePinToUnpin(pins, "spreadsheet")).toEqual({ kind: "none" });
  });
});
