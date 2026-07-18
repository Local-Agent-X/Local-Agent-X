// Regression guard for the empty-state FLASH — first paint renders the static
// #empty markup in app.html, and only later does home-launcher.js/chat-render.js
// re-render it from emptyHTML(). Any drift between those copies is shown to
// every user for the first ~second of every load. The 2026-07-14 report: the
// static copy still carried the retired /hero.jpg card art, so the old artwork
// flashed on top of the new full-photo background on every boot.
//
// Look can't be asserted headlessly; the sync invariants can:
//   1. no copy of the empty state references the retired hero art;
//   2. the static app.html #empty and the emptyHTML() generator agree on the
//      layout skeleton (same data-home variants, same starter cards);
//   3. the chat-render.js fallback matches the generator's classic hero.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => readFileSync(join(here, "..", "public", f), "utf8");

let appHtml = "";
let launcherJs = "";
let chatRenderJs = "";
let staticEmpty = "";

beforeAll(() => {
  appHtml = pub("app.html");
  launcherJs = pub("js/home-launcher.js");
  chatRenderJs = pub("js/chat-render.js");
  const m = appHtml.match(/<div id="empty">[\s\S]*?\n {8}<\/div>/);
  expect(m, "static #empty block present in app.html").toBeTruthy();
  staticEmpty = m![0];
});

describe("home empty-state parity (no first-paint flash of stale markup)", () => {
  it("no empty-state copy references the retired hero card art", () => {
    for (const [name, src] of [
      ["app.html", appHtml],
      ["home-launcher.js", launcherJs],
      ["chat-render.js", chatRenderJs],
    ] as const) {
      expect(src, `${name} references hero.jpg`).not.toMatch(/hero\.jpg/);
      expect(src, `${name} references hero-light.png`).not.toMatch(/hero-light\.png/);
      expect(src, `${name} uses the retired .hero-img class`).not.toMatch(/hero-img/);
    }
  });

  it("static #empty and emptyHTML() agree on layout variants and starter cards", () => {
    for (const variant of ['data-home="classic"', 'data-home="command"']) {
      expect(staticEmpty).toContain(variant);
      expect(launcherJs).toContain(variant);
    }
    const staticStarters = [...staticEmpty.matchAll(/data-starter="([a-z]+)"/g)]
      .map((m) => m[1]).sort();
    // The generator emits data-starter through its card() helper, so the
    // starter set there is the list of card('<key>', …) calls.
    const generatorStarters = [...launcherJs.matchAll(/card\('([a-z]+)',/g)]
      .map((m) => m[1]).sort();
    expect(staticStarters.length).toBeGreaterThan(0);
    expect(staticStarters).toEqual(generatorStarters);
  });

  it("routes the Build starter through the explicit app-build methodology", () => {
    expect(staticEmpty).toMatch(/data-starter="build"[^>]*data-prompt="\/app-build Build me "/);
    expect(launcherJs).toContain(`card('build', 'data-prompt="/app-build Build me "'`);
    expect(staticEmpty).not.toContain('data-prompt="Build me an app that "');
    expect(launcherJs).not.toContain('data-prompt="Build me an app that "');
  });

  it("static #empty paints no <img> before JS runs — the background owns the art", () => {
    expect(staticEmpty).not.toMatch(/<img/);
  });

  it("chat-render fallback matches the generator's classic hero skeleton", () => {
    const fallback = chatRenderJs.match(/id="empty"[^`]*/)?.[0] ?? "";
    expect(fallback).toContain('data-home="classic"');
    expect(fallback).not.toMatch(/<img/);
  });
});
