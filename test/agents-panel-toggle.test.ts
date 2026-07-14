// Regression guard for the agents-panel opener consolidation.
//
// The floating "AGENTS <n>" pill that hovered over the chat area was removed:
// the window-top bar is now the ONLY mouse affordance that opens the agents
// sidebar. Two top-bar toggles exist in the DOM — #dtb-agents-toggle inside
// the Windows in-window titlebar, and #sidebar-agents-btn in the window-top
// #sidebar-agents-controls cluster (pinned top-right) for macOS/browser — and
// CSS guarantees exactly one renders per platform (platform-win hides the
// cluster copy; the titlebar itself only renders under platform-win).
//
// These are source-text invariants, mirroring boot-reveal-gate.test.ts.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let html = "";
let css = "";

// Body of a top-level `function name() { ... }`, up to the first closing brace
// in column 0. Scoping to the body matters: a bare /function foo\(\)[\s\S]*bar/
// is satisfied by a `bar` ANYWHERE later in the file, so it keeps passing after
// the call is deleted out of foo — a test that cannot fail.
function fnBody(src: string, name: string): string {
  const m = src.match(new RegExp(`function ${name}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`function ${name}() not found — rename or refactor?`);
  return m[1];
}

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
    expect(css).toMatch(/body\.platform-win #sidebar-agents-controls\{[^}]*display:none/);
  });

  it("the macOS/browser copy sits in its own top-right cluster, not the left one", () => {
    // Split out of #sidebar-controls so it renders on the same side as the
    // right panel it toggles.
    expect(html).toMatch(/id="sidebar-agents-controls"[\s\S]*id="sidebar-agents-btn"/);
    expect(css).toMatch(/#sidebar-agents-controls\{[^}]*position:fixed[^}]*right:/);
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

// The three top-bar panel toggles (#sidebar-hide-btn, #dtb-agents-toggle,
// #sidebar-agents-btn) are peers in one bar and must read identically:
// muted at rest, --text on hover, --accent while their panel is open. They
// drifted once already — the titlebar copy sat at --text at rest while the
// cluster copies sat at --muted, and the nav button had no open state at all,
// so the same bar showed two different colors closed and two green tones open.
// Each `it` below pins one leg of that treatment.
describe("top-bar panel toggles share one color treatment", () => {
  it("every toggle rests at --muted, none at --text", () => {
    // --text at rest is the specific drift that made the titlebar copy brighter
    // than its peers — and it also silently defeats the button's own :hover,
    // which resolves to the very same colour.
    expect(css).toMatch(/#desktop-titlebar \.dtb-btn-icon\{[^}]*color:var\(--muted\)/);
    expect(css).toMatch(/#sidebar-controls button\{[^}]*color:var\(--muted\)/);
    expect(css).toMatch(/#sidebar-agents-controls button\{[^}]*color:var\(--muted\)/);
    expect(css).not.toMatch(/#desktop-titlebar \.dtb-btn-icon\{[^}]*color:var\(--text\)/);
  });

  it("one is-open rule accents all three toggles", () => {
    // A single rule, not per-button copies that can drift apart again.
    const openRule = css.match(
      /#sidebar-controls button\.is-open,\s*#sidebar-agents-controls button\.is-open,\s*#desktop-titlebar #dtb-agents-toggle\.is-open\{([^}]*)\}/,
    );
    expect(openRule, "the shared is-open rule must cover all three toggles").not.toBeNull();
    expect(openRule![1]).toContain("color:var(--accent)");
  });

  it("the is-open rule outranks :hover by source order", () => {
    // The cluster selectors tie with their :hover rules on specificity, so
    // source order is what makes an open panel's button hold accent while
    // hovered. Moving the rule up would silently break only the hover case.
    const hoverAt = css.lastIndexOf("button:hover{color:var(--text)");
    const openAt = css.indexOf("button.is-open,");
    expect(hoverAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(hoverAt);
  });

  it("state is applied through the one flip-aware resolver, not per-button", () => {
    const js = readFileSync(join(here, "../public/js/app-sidebar-toggle.js"), "utf8");
    // panelOnSide() decides which panel a button controls; the is-open class
    // must be set from that same pass so the accent follows the flip.
    const body = fnBody(js, "refreshSideButtons");
    expect(body).toContain("panelOnSide(side)");
    expect(body).toContain("classList.toggle('is-open'");
  });

  it("both panels' toggles refresh their button after a change", () => {
    // The nav path forgot this, which is why only the agents button ever lit
    // up. Each toggle must repaint the bar.
    const js = readFileSync(join(here, "../public/js/app-sidebar-toggle.js"), "utf8");
    expect(fnBody(js, "toggleNavSidebar")).toContain("refreshSideButtons()");
    expect(fnBody(js, "flipSidebarSide")).toContain("refreshSideButtons()");
    const feedsJs = readFileSync(join(here, "../public/js/chat-agent-feeds.js"), "utf8");
    expect(fnBody(feedsJs, "toggleAgentFeeds")).toContain("refreshSideButtons()");
  });

  it("the boot refresh waits for DOMContentLoaded, not parse time", () => {
    // Both button clusters are the LAST elements in <body> (paint-order rule
    // for the macOS drag strips) while app-sidebar-toggle.js is parsed far
    // above them. A parse-time refresh therefore finds no buttons and leaves
    // every tooltip/accent at the hardcoded HTML default. The call must live
    // inside the DCL-gated reveal.
    const js = readFileSync(join(here, "../public/js/app-sidebar-toggle.js"), "utf8");
    const reveal = js.match(/const reveal = \(\) => \{([\s\S]*?)\n {2}\};/);
    expect(reveal, "the DCL-gated reveal() must exist").not.toBeNull();
    expect(reveal![1]).toContain("refreshSideButtons()");
    // …and must NOT also fire bare at parse time (the old bug).
    const boot = js.slice(js.indexOf("// Restore sidebar state on load"));
    expect(boot).not.toMatch(/\n {2}refreshSideButtons\(\);/);
  });

  it("the agents toggles ship the tooltip their closed-at-boot state implies", () => {
    // Pre-DCL the HTML attribute is what a hover shows. The agents panel boots
    // collapsed, so "Hide" would be a lie in the one window where JS hasn't
    // corrected it yet.
    expect(html).toMatch(/id="dtb-agents-toggle"[^>]*title="Show sidebar"/);
    expect(html).toMatch(/id="sidebar-agents-btn"[^>]*title="Show sidebar"/);
  });

  it("closing the agents panel drops its body class synchronously", () => {
    // If the class is cleared inside the spring's onDone, the synchronous
    // refresh right after reads the stale open state and the button stays
    // accented after the panel is gone.
    const feedsJs = readFileSync(join(here, "../public/js/chat-agent-feeds.js"), "utf8");
    const onDoneBlocks = feedsJs.match(/onDone:\s*function\(\)\s*\{[^}]*\}/g) || [];
    for (const block of onDoneBlocks) {
      expect.soft(block, "agents-panel-open must not be cleared in an onDone").not.toContain(
        "remove('agents-panel-open')",
      );
    }
    expect(feedsJs).toContain("document.body.classList.remove('agents-panel-open');");
  });
});
