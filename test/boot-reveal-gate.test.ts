// Regression guard for the BOOT REVEAL GATE — the mechanism that keeps the app
// shell from assembling piecemeal on first load / refresh (public/css/app.css +
// public/js/app.js).
//
// The shell paints in stages: app.css applies before first paint, but the
// platform-win class (titlebar + layout) lands at the preload's DOMContentLoaded
// and the sidebar lists + composer pickers are built by JS around the same time.
// If each stage is revealed as it lands, the user sees the titleless fallback
// layout flash, then chrome pop in, then the lists fade up last — the "missing
// tons of stuff on refresh" report. The fix holds the WHOLE shell hidden until
// app.js flips body.app-ready, then reveals it atomically.
//
// A CSS/timing fade can't have its *look* asserted headlessly, but its
// behavioral invariants can, and those are exactly what a careless refactor
// drops silently:
//   1. every top-level shell container starts opacity:0 (hidden until built);
//   2. body.app-ready reveals them (the atomic swap);
//   3. app.js flips app-ready after the first navigate AND on a safety-net timer,
//      so a boot that throws before the rAF still reveals the shell.
// We parse the source text and assert these, mirroring the other CSS-invariant
// guards in this suite.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const flat = (s: string) => s.replace(/\s+/g, " ");
let css = "";
let appJs = "";

// The top-level shell regions that must be gated together. Missing any one of
// these from the gate reintroduces a piecemeal flash for that region — e.g.
// dropping #desktop-titlebar brings back the titleless fallback frame.
const SHELL_IDS = ["#desktop-titlebar", "#sidebar", "#main"];

beforeAll(() => {
  css = flat(readFileSync(join(here, "../public/css/app.css"), "utf8"));
  appJs = readFileSync(join(here, "../public/js/app.js"), "utf8");
});

describe("boot reveal gate (shell anti-FOUC)", () => {
  it("hides every top-level shell container by default (opacity:0)", () => {
    // The default rule that holds the shell hidden before app-ready. Match the
    // gate rule specifically (opacity:0 + a fade transition) so an unrelated
    // opacity:0 elsewhere can't satisfy the check.
    const gate = css.match(/([#\w.,\- ]*)\{opacity:0;transition:opacity[^}]*\}/g) || [];
    const gateSelectors = gate.join(" ");
    for (const id of SHELL_IDS) {
      expect.soft(gateSelectors, `${id} must be in the opacity:0 boot gate`).toContain(id);
    }
    expect(gate.length).toBeGreaterThan(0);
  });

  it("reveals the shell only under body.app-ready", () => {
    const reveal = css.match(/body\.app-ready[^{]*\{opacity:1\}/g) || [];
    const revealSelectors = reveal.join(" ");
    for (const id of SHELL_IDS) {
      expect.soft(revealSelectors, `${id} must be revealed under body.app-ready`).toContain(id);
    }
    expect(reveal.length).toBeGreaterThan(0);
  });

  it("app.js flips app-ready after the first navigate", () => {
    // bootNavigate must run navigate() first, then arm app-ready — revealing an
    // already-built shell rather than an empty one.
    expect(appJs).toMatch(/function bootNavigate\(\)\s*\{[\s\S]*navigate\(currentRoute\(\)\)[\s\S]*app-ready[\s\S]*\}/);
  });

  it("arms an app-ready safety net so a throwing boot still reveals the shell", () => {
    // Without this timer, an exception in navigate() before the rAF would leave
    // the entire shell invisible forever. The net is the load-bearing backstop.
    expect(appJs).toMatch(/setTimeout\(\(\)\s*=>\s*document\.body\.classList\.add\('app-ready'\)\s*,\s*\d+\)/);
  });
});
