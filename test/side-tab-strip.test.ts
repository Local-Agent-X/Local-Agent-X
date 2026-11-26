// @vitest-environment happy-dom
// The side panel's tab icons live in the top bar, not in the panel
// (2026-11-25: a row of icons inside the panel duplicated the top bar's job).
// One strip sits beside the toggle of the panel it switches: the Windows
// titlebar's, the window-top cluster's on macOS and in a browser, the left
// cluster's when the panels are flipped. A click opens the panel on that tab,
// turns an open panel to it, and closes the panel already showing it.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "../public/app.html"), "utf8");
const toggleSrc = readFileSync(join(here, "../public/js/app-sidebar-toggle.js"), "utf8");
const artifactsSrc = readFileSync(join(here, "../public/js/chat-artifacts.js"), "utf8");

// The strip exactly as app.html ships it.
const stripHtml = html.slice(html.indexOf('<div id="side-tab-strip"'), html.indexOf("</div>", html.indexOf('<div id="side-tab-strip"')) + 6);

type Page = {
  placeSideTabStrip(): void;
  sidePanelTabClick(t: string): void;
  current(): string;
};

function load(bodyClass = ""): Page {
  localStorage.clear();
  document.body.className = bodyClass;
  document.body.innerHTML = `
    <div id="desktop-titlebar"><div id="dtb-overflow"></div><span id="dtb-agents-toggle"></span></div>
    <div id="agent-feeds" class="agent-feeds collapsed">
      ${["overview", "agents", "preview", "inbox", "artifacts", "changes", "browser", "android", "terminal"]
        .map((t) => `<div id="${t}-tab-body" class="side-tab-body"></div>`).join("")}
    </div>
    <div id="sidebar-controls"><button id="sidebar-hide-btn"></button><button id="sidebar-flip-btn"></button></div>
    <div id="sidebar-agents-controls">${stripHtml}<button id="sidebar-agents-btn"></button></div>`;
  const w = window as unknown as Record<string, unknown>;
  w.agentFeedsOpen = false;
  w.toggleAgentFeeds = () => {
    w.agentFeedsOpen = !w.agentFeedsOpen;
    document.body.classList.toggle("agents-panel-open", w.agentFeedsOpen as boolean);
  };
  const toggle = new Function(`${toggleSrc}\nreturn { placeSideTabStrip };`)();
  const tabs = new Function(`${artifactsSrc}\nreturn { sidePanelTabClick, current: () => sidePanelTab };`)();
  return { ...toggle, ...tabs };
}

const open = () => (window as unknown as { agentFeedsOpen: boolean }).agentFeedsOpen;
const strip = () => document.getElementById("side-tab-strip")!;

describe("the tab icons sit in the top bar", () => {
  it("app.html has no tab row inside the panel", () => {
    const panel = html.slice(html.indexOf('<div id="agent-feeds"'), html.indexOf('<div id="side-tab-strip"'));
    expect(panel).not.toContain('class="side-panel-tab');
    expect(panel).not.toContain("agent-feeds-header");
    expect(stripHtml.match(/class="side-panel-tab/g)).toHaveLength(9);
  });

  it("on Windows, in the titlebar just before the panel toggle", () => {
    const page = load("platform-win");
    page.placeSideTabStrip();
    expect(strip().parentElement!.id).toBe("desktop-titlebar");
    expect(strip().nextElementSibling!.id).toBe("dtb-agents-toggle");
  });

  it("on macOS and in a browser, in the window-top cluster before its toggle", () => {
    const page = load("platform-darwin");
    page.placeSideTabStrip();
    expect(strip().parentElement!.id).toBe("sidebar-agents-controls");
    expect(strip().nextElementSibling!.id).toBe("sidebar-agents-btn");
  });

  it("flipped, beside the left toggle, which now opens this panel", () => {
    const page = load("platform-win sidebar-right");
    page.placeSideTabStrip();
    expect(strip().parentElement!.id).toBe("sidebar-controls");
  });
});

describe("clicking a tab icon", () => {
  it("opens a closed panel on that tab", () => {
    const page = load();
    page.sidePanelTabClick("browser");
    expect(open()).toBe(true);
    expect(page.current()).toBe("browser");
    expect(document.getElementById("side-tab-browser")!.classList.contains("active")).toBe(true);
  });

  it("turns an open panel to another tab without closing it", () => {
    const page = load();
    page.sidePanelTabClick("browser");
    page.sidePanelTabClick("terminal");
    expect(open()).toBe(true);
    expect(page.current()).toBe("terminal");
  });

  it("closes the panel when it is already showing that tab", () => {
    const page = load();
    page.sidePanelTabClick("inbox");
    page.sidePanelTabClick("inbox");
    expect(open()).toBe(false);
  });
});
