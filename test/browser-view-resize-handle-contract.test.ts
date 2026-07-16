// Regression guard: the right pane must stay draggable while the BROWSER tab
// is open.
//
// The BROWSER tab does not render its page in the DOM. browser-tab.js sync()
// measures #browser-view-anchor with getBoundingClientRect() and hands that
// rect to main, which parks a NATIVE Electron view there. A native view is not
// part of the document: it paints above every element no matter the z-index,
// and it swallows every mouse event inside its rect.
//
// .agent-feeds-resize-handle is absolutely positioned at the panel's edge and
// spans its FULL height. #browser-view-anchor is a normal-flow child of a panel
// with no padding, so without an inset its rect starts at that same edge and
// the native view lands on top of the handle. Live symptom: the pane could only
// be dragged from ABOVE the address bar — the one strip where no native view is
// painted — and was dead everywhere below it.
//
// The invariant is that the handle's width and the anchor's inset stay equal.
// They live in two different rules, so they are pinned to one token here; a
// drift between them silently re-opens the bug (a too-small inset leaves the
// handle partly covered, which reads as "flaky drag" rather than a clean
// failure). jsdom does no layout, so the rect can't be asserted directly —
// this locks the CSS contract that produces it instead.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let css = "";
let html = "";
let js = "";

beforeAll(() => {
  css = readFileSync(join(here, "..", "public", "css", "app.css"), "utf-8");
  html = readFileSync(join(here, "..", "public", "app.html"), "utf-8");
  js = readFileSync(join(here, "..", "public", "js", "browser-tab.js"), "utf-8");
});

// Bodies of every rule whose selector list contains `selector` exactly, in
// source order. A selector legitimately appears more than once (`:root` is both
// the theme token block and a local one; #browser-view-anchor has a mobile
// @media override), so callers must scan rather than trust the first hit.
// Comments are stripped so a selector named in prose can't match.
function ruleBodies(selector: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const sels = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out;
}

// First declared value of `prop` across those rules — i.e. the desktop rule,
// since the mobile @media overrides come later in the file.
function decl(selector: string, prop: string): string | null {
  for (const body of ruleBodies(selector)) {
    const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) return m[1].trim();
  }
  return null;
}

describe("browser view must not cover the right pane's resize handle", () => {
  it("the drag-strip width is a single token, not a repeated magic number", () => {
    expect(decl(":root", "--feeds-resize-w")).toBeTruthy();
  });

  it("the handle's width comes from that token", () => {
    expect(decl(".agent-feeds-resize-handle", "width")).toBe("var(--feeds-resize-w)");
  });

  it("the anchor is inset by the SAME token — an unequal inset re-opens the bug", () => {
    expect(decl("#browser-view-anchor", "margin-left")).toBe("var(--feeds-resize-w)");
  });

  it("the inset follows the handle when the panel flips sides", () => {
    // body.sidebar-right moves the handle to right:0, so the inset must move too.
    expect(decl("body.sidebar-right .agent-feeds-resize-handle", "right")).toBe("0");
    expect(decl("body.sidebar-right #browser-view-anchor", "margin-right")).toBe("var(--feeds-resize-w)");
    expect(decl("body.sidebar-right #browser-view-anchor", "margin-left")).toBe("0");
  });

  it("still measures the anchor to place the native view — the rect IS the contract", () => {
    // If this ever stops reading the anchor's rect, the CSS inset above is
    // no longer what keeps the view off the handle, and this guard is void.
    expect(js).toMatch(/getElementById\(['"]browser-view-anchor['"]\)/);
    expect(js).toMatch(/getBoundingClientRect\(\)/);
    expect(js).toMatch(/setBounds\(/);
  });

  it("the anchor and the handle still live in the same panel", () => {
    expect(html).toContain('id="browser-view-anchor"');
    expect(html).toContain('class="agent-feeds-resize-handle"');
  });
});
