/**
 * The skin library: what the user (or the agent, or another machine's sync)
 * puts in a skin is checked before the window is painted from it, and a
 * skin's files stay inside its own folder.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { contrastRatio } from "../tools/shared/slide-checks.js";
import { BRAIN_DIRS, MAX_FILE_SIZE, SYNC_EXTENSIONS, TOMBSTONED_BRAIN_DIRS } from "../sync/constants.js";
import { findSkin, listSkins, normalizeSkin, saveSkin, skinDir, skinsDir } from "./skin-store.js";
import {
  MAX_SKIN_FILE_BYTES, SKIN_BACKGROUND_EXT, SKIN_CODE_FILE, clearSkinBackground, removeSkin, setSkinBackground, setSkinEffectCode,
} from "./skin-files.js";

beforeEach(() => { rmSync(skinsDir(), { recursive: true, force: true }); });

describe("skin store", () => {
  it("saves a skin, changes only the fields given, and finds it by name", () => {
    const made = saveSkin({ name: "Winter Lodge", colors: { surface: "#101820", accent: "#7fd4ff" }, opacity: 0.6, effect: { kind: "snow", reactive: true } });
    expect(made).toMatchObject({ slug: "winter-lodge", opacity: 0.6, colors: { surface: "101820" }, effect: { kind: "snow", density: 1, reactive: true } });
    const changed = saveSkin({ blur: 12, effect: { size: 2 } }, "winter lodge");
    expect(changed).toMatchObject({ slug: "winter-lodge", opacity: 0.6, blur: 12, effect: { kind: "snow", size: 2, reactive: true } });
    expect(listSkins().map((s) => s.name)).toEqual(["Winter Lodge"]);
    expect(saveSkin({ effect: null }, "winter-lodge").effect).toBeUndefined();
  });

  it("gives a second skin of the same slug its own folder, and never a path", () => {
    saveSkin({ name: "A/B" });
    writeFileSync(join(skinDir("a-b"), "skin.json"), JSON.stringify({ name: "A-B" }));
    expect(saveSkin({ name: "a b" }).slug).toBe("a-b-2");
    expect(saveSkin({ name: "../../etc" }).slug).toBe("etc");
  });

  it("clamps every number and drops what it does not know", () => {
    const s = normalizeSkin({
      name: "x", opacity: 0, blur: 9000, dim: 5, fit: "stretch", background: "../../secrets.json", code: "effect.js",
      effect: { kind: "fireworks", density: 99 }, colors: { accent: "red", bg: "#abc" },
    }, "x")!;
    expect(s).toMatchObject({ opacity: 0.15, blur: 40, dim: 0.9, fit: "cover", code: "effect.js", colors: { bg: "AABBCC" } });
    expect(s.background).toBeUndefined();
    expect(s.effect).toBeUndefined();
    expect(normalizeSkin({ name: "x", effect: { kind: "rain", density: 99, speed: -1, size: 0 } }, "x")!.effect)
      .toEqual({ kind: "rain", density: 3, speed: 0.2, size: 0.5, reactive: false });
  });

  it("moves text until it reads on the panel, and keeps no text color without one", () => {
    const dark = saveSkin({ name: "Unreadable", colors: { surface: "#101010", text: "#181818", accent: "#111111" } });
    expect(contrastRatio(dark.colors.text!, "101010")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.colors.accent!, "101010")).toBeGreaterThanOrEqual(2);
    const light = saveSkin({ name: "Pale", colors: { bg: "#FFFFFF", text: "#FAFAFA" } });
    expect(contrastRatio(light.colors.text!, "FFFFFF")).toBeGreaterThanOrEqual(4.5);
    // The built-in palette's panel changes with light and dark mode, so a
    // text color alone could be unreadable in one of them.
    expect(saveSkin({ name: "Text only", colors: { text: "#000000" } }).colors).toEqual({});
  });

  it("keeps the skin's word on the app's graphic, and no word when it has none", () => {
    expect(saveSkin({ name: "Plain" }).graphic).toBeUndefined();
    expect(saveSkin({ graphic: true }, "plain").graphic).toBe(true);
    expect(saveSkin({ blur: 3 }, "plain").graphic).toBe(true);
    expect(saveSkin({ graphic: false }, "plain").graphic).toBe(false);
    expect(normalizeSkin({ name: "x", graphic: "yes" }, "x")!.graphic).toBeUndefined();
  });

  it("refuses the custom effect until the skin has code", () => {
    saveSkin({ name: "Own" });
    expect(() => saveSkin({ effect: { kind: "custom" } }, "own")).toThrow(/no effect code yet/);
  });
});

describe("skin files", () => {
  it("copies a background in, replaces one of another type, and takes it out", async () => {
    saveSkin({ name: "Beach" });
    const first = await setSkinBackground("Beach", { name: "My Photo (1).PNG", data: Buffer.from("png-bytes") });
    expect(first.background).toBe("background.png");
    const second = await setSkinBackground("beach", { name: "loop.webm", data: Buffer.from("webm-bytes") });
    expect(second.background).toBe("background.webm");
    expect(existsSync(join(skinDir("beach"), "background.png"))).toBe(false);
    expect(readFileSync(join(skinDir("beach"), "background.webm"), "utf-8")).toBe("webm-bytes");
    expect((await clearSkinBackground("beach")).background).toBeUndefined();
    expect(existsSync(join(skinDir("beach"), "background.webm"))).toBe(false);
  });

  it("refuses a file the window cannot paint, or one too big to sync", async () => {
    saveSkin({ name: "Beach" });
    await expect(setSkinBackground("beach", { name: "page.svg", data: Buffer.from("<svg/>") })).rejects.toThrow(/A background can be/);
    await expect(setSkinBackground("beach", { name: "run.js", data: Buffer.from("x") })).rejects.toThrow(/A background can be/);
    await expect(setSkinBackground("beach", { name: "big.mp4", data: Buffer.alloc(MAX_SKIN_FILE_BYTES + 1) })).rejects.toThrow(/up to 10 MB/);
    await expect(setSkinBackground("nope", { name: "a.png", data: Buffer.from("x") })).rejects.toThrow(/No saved theme/);
  });

  it("saves effect code under one fixed name and makes it the skin's effect", () => {
    saveSkin({ name: "Aurora Sky", effect: { kind: "stars", speed: 2 } });
    expect(() => setSkinEffectCode("aurora-sky", "let x = 1;")).toThrow(/must define draw/);
    const s = setSkinEffectCode("aurora-sky", "function draw(ctx, s, dt) { ctx.fillRect(0, 0, s.w * s.context, 4); }");
    expect(s).toMatchObject({ code: SKIN_CODE_FILE, effect: { kind: "custom", speed: 2 } });
    expect(readFileSync(join(skinDir("aurora-sky"), SKIN_CODE_FILE), "utf-8")).toMatch(/function draw/);
    expect(findSkin("Aurora Sky")?.effect?.kind).toBe("custom");
  });

  it("removes a skin to the trash and leaves a tombstone for the other machines", async () => {
    const dataDir = join(skinsDir(), "..");
    const tombstones = join(dataDir, "sync-repo", ".tombstones", "skins");
    mkdirSync(join(dataDir, "sync-repo"), { recursive: true });
    try {
      saveSkin({ name: "Gone" });
      await removeSkin("gone");
      expect(findSkin("gone")).toBeNull();
      expect(existsSync(skinDir("gone"))).toBe(false);
      expect(existsSync(join(tombstones, "gone.json"))).toBe(true);
    } finally { rmSync(join(dataDir, "sync-repo"), { recursive: true, force: true }); }
  });
});

describe("skins travel with sync", () => {
  it("are a brain folder whose deletes are tombstoned, and every file a skin holds is one sync carries", () => {
    expect(BRAIN_DIRS).toContain("skins");
    expect(TOMBSTONED_BRAIN_DIRS.has("skins")).toBe(true);
    for (const ext of [...SKIN_BACKGROUND_EXT, ".json", ".js"]) expect(SYNC_EXTENSIONS.has(ext), ext).toBe(true);
    expect(MAX_SKIN_FILE_BYTES).toBeLessThanOrEqual(MAX_FILE_SIZE);
  });
});
