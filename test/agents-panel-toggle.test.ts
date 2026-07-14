// Regression guard for the agents-panel opener consolidation.
//
// The floating "AGENTS <n>" pill that hovered over the chat area was removed:
// the window-top bar is now the ONLY mouse affordance that opens the agents
// sidebar. Two top-bar toggles exist in the DOM — #dtb-agents-toggle inside
// the Windows in-window titlebar, and #sidebar-agents-btn in the window-top
// #sidebar-controls cluster for macOS/browser — and CSS guarantees exactly
// one renders per platform (platform-win hides the cluster copy; the titlebar
// itself only renders under platform-win).
//
// These are source-text invariants, mirroring boot-reveal-gate.test.ts.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let html = "";
let css = "";

beforeAll(() => {
  html = readFileSync(join(here, "../public/app.html"), "utf8");
  css = readFileSync(join(here, "../public/css/app.css"), "utf8").replace(/\s+/g, " ");
});

describe("agents panel opener (top-bar only)", () => {
  it("the floating AGENTS pill does not exist", () => {
    expect(html).not.toContain('id="agents-toggle"');
    expect(html).not.toContain("agents-toggle-count");
  });

  it("both top-bar toggles exist and drive the right-side panel", () => {
    expect(html).toContain('id="dtb-agents-toggle"');
    expect(html).toContain('id="sidebar-agents-btn"');
    // Both go through the flip-aware side dispatch, not a hardcoded panel.
    expect(html).toMatch(/id="dtb-agents-toggle"[^>]*onclick="toggleSidePanel\('right'\)"/);
    expect(html).toMatch(/id="sidebar-agents-btn"[^>]*onclick="toggleSidePanel\('right'\)"/);
  });

  it("platform-win hides the window-top copy so Windows shows exactly one", () => {
    expect(css).toMatch(/body\.platform-win #sidebar-agents-btn\{[^}]*display:none/);
  });

  it("menu paths call toggleAgentFeeds directly, not the removed pill", () => {
    const titlebarJs = readFileSync(join(here, "../public/js/desktop-titlebar.js"), "utf8");
    const appMenuTs = readFileSync(join(here, "../desktop/src/app-menu.ts"), "utf8");
    expect(titlebarJs).not.toContain("agents-toggle");
    expect(appMenuTs).not.toContain("agents-toggle");
    expect(titlebarJs).toContain("toggleAgentFeeds");
    expect(appMenuTs).toContain("toggleAgentFeeds");
  });
});
