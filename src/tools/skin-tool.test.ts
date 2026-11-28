/**
 * The agent builds the user a theme for the app window from chat: saves it,
 * turns it on, gives it a picture and its own moving layer, and takes it off.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { skinTool } from "./skin-tool.js";
import { workspaceRoot } from "../config.js";
import { loadSettings, setSetting } from "../settings.js";
import { findSkin, skinsDir } from "../skins/skin-store.js";

const call = (args: Record<string, unknown>) => skinTool.execute(args) as Promise<{ content: string; isError?: boolean }>;
const activeSkin = () => (loadSettings() as Record<string, unknown>).skin;

beforeEach(() => {
  rmSync(skinsDir(), { recursive: true, force: true });
  setSetting("skin", "");
  mkdirSync(join(workspaceRoot(), "skin-in"), { recursive: true });
});

describe("skin tool", () => {
  it("saves a theme from chat and turns it on", async () => {
    const saved = await call({ action: "save", name: "Christmas", colors: '{"surface":"#0d1f17","accent":"#e63946"}', opacity: 0.55, effect: { kind: "snow", reactive: true } });
    expect(saved.isError).toBeFalsy();
    expect(saved.content).toMatch(/^Saved theme: \(it is on now\)\nChristmas \(on now\)/);
    expect(saved.content).toMatch(/Moving layer: snow .*grows as context fills/);
    expect(activeSkin()).toBe("christmas");
    expect((await call({ action: "list" })).content).toMatch(/Panels: 55% solid/);
  });

  it("changes a theme without making a second, and can save without turning it on", async () => {
    await call({ action: "save", name: "Christmas", apply: false });
    expect(activeSkin()).toBe("");
    const r = await call({ action: "save", name: "christmas", blur: 8, effect: "none", apply: false });
    expect(r.content).toMatch(/^Updated theme:/);
    expect(findSkin("Christmas")).toMatchObject({ blur: 8, effect: undefined });
  });

  it("copies a picture in from the workspace and refuses what is not one", async () => {
    await call({ action: "save", name: "Beach", apply: false });
    const picture = join(workspaceRoot(), "skin-in", "sunset.png");
    writeFileSync(picture, Buffer.from("png-bytes"));
    expect((await call({ action: "set_background", name: "Beach", path: picture })).content).toMatch(/Background: background\.png, cover/);
    const script = join(workspaceRoot(), "skin-in", "run.js");
    writeFileSync(script, "x");
    const refused = await call({ action: "set_background", name: "Beach", path: script });
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/A background can be/);
    // With a background the app's graphic is hidden until the theme asks for it.
    expect((await call({ action: "get", name: "Beach" })).content).toMatch(/App graphic .*: hidden/);
    expect((await call({ action: "save", name: "Beach", graphic: true, apply: false })).content).toMatch(/App graphic .*: shown/);
    expect((await call({ action: "clear_background", name: "Beach" })).content).toMatch(/Background: none/);
  });

  it("saves its own moving layer for a theme", async () => {
    await call({ action: "save", name: "Meter", apply: false });
    const r = await call({ action: "set_effect_code", name: "Meter", code: "function draw(ctx, s, dt) { ctx.fillRect(0, s.h - 4, s.w * s.context, 4); }" });
    expect(r.content).toMatch(/Moving layer: custom/);
    expect((await call({ action: "set_effect_code", name: "Meter", code: "" })).isError).toBe(true);
  });

  it("turns a theme on by name, off with none, and removing the one that is on turns it off", async () => {
    await call({ action: "save", name: "Beach", apply: false });
    await call({ action: "apply", name: "beach" });
    expect(activeSkin()).toBe("beach");
    expect((await call({ action: "apply", name: "none" })).content).toMatch(/built-in look/);
    expect(activeSkin()).toBe("");
    await call({ action: "apply", name: "Beach" });
    expect((await call({ action: "remove", name: "Beach" })).content).toMatch(/in the trash/);
    expect(activeSkin()).toBe("");
    expect((await call({ action: "apply", name: "Beach" })).isError).toBe(true);
  });
});
