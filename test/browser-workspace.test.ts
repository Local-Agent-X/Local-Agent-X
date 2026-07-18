// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../public/js/browser-workspace.js"), "utf8");
const CSS = readFileSync(join(here, "../public/css/browser-workspace.css"), "utf8");
const ARTIFACTS_SRC = readFileSync(join(here, "../public/js/chat-artifacts.js"), "utf8");

function loadWorkspace(): void {
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
}

beforeEach(() => {
  document.body.className = "";
  document.body.innerHTML = `
    <div id="page-chat" class="active">
      <div id="chat-main"><div id="messages"></div><div id="input-area"></div></div>
      <div id="agent-feeds" class="active">
        <div class="agent-feeds-header"><button id="side-tab-browser" class="active">BROWSER</button></div>
        <div id="browser-tab-body"><div id="browser-address-bar"></div><div id="browser-view-anchor"></div></div>
      </div>
    </div>`;
  Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
  (window as any).laxBrowserTab = { sync: vi.fn() };
  delete (window as any).laxBrowserWorkspace;
});

describe("Browser full-page workspace", () => {
  it("reuses chat-main and toggles full-page mode from the Browser toolbar", () => {
    const chat = document.getElementById("chat-main");
    loadWorkspace();

    const toggle = document.getElementById("browser-workspace-toggle") as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();

    expect(document.body.classList.contains("browser-workspace")).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("chat-main")).toBe(chat);
  });

  it("collapses the chat dock to a bar and expands it without losing chat DOM", () => {
    loadWorkspace();
    (window as any).laxBrowserWorkspace.setActive(true);
    const messages = document.getElementById("messages");
    const collapse = document.getElementById("browser-chat-collapse") as HTMLButtonElement;

    collapse.click();
    expect(document.body.classList.contains("browser-chat-collapsed")).toBe(true);
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    expect(collapse.title).toBe("Expand chat");
    expect(document.getElementById("messages")).toBe(messages);

    collapse.click();
    expect(document.body.classList.contains("browser-chat-collapsed")).toBe(false);
    expect(collapse.title).toBe("Collapse chat");
  });

  it("keeps only the compact composer visible over the Browser workspace", () => {
    expect(CSS).toContain("--browser-chat-dock-height:96px");
    expect(CSS).toContain("body.browser-workspace #chat-main #messages,");
    expect(CSS).toContain("body.browser-workspace #chat-main #context-bar,");
    expect(CSS).toContain("body.browser-workspace #chat-main #status-bar{display:none!important}");
    expect(CSS).toContain("background:transparent;box-shadow:none");
    expect(CSS).toContain("width:min(100%,840px)");
  });

  it("restores the ordinary split when Browser is hidden", () => {
    loadWorkspace();
    (window as any).laxBrowserWorkspace.setActive(true);
    (window as any).laxBrowserWorkspace.setCollapsed(true);
    (window as any).laxBrowserWorkspace.onTabHidden();

    expect(document.body.classList.contains("browser-workspace")).toBe(false);
    expect(document.body.classList.contains("browser-chat-collapsed")).toBe(false);
    expect((window as any).laxBrowserWorkspace.isActive()).toBe(false);
    expect((window as any).laxBrowserWorkspace.isCollapsed()).toBe(false);
  });

  it("is wired into the canonical side-panel tab switch", () => {
    expect(ARTIFACTS_SRC).toContain("window.laxBrowserWorkspace.onTabHidden()");
    expect(ARTIFACTS_SRC).toContain("tab !== 'browser'");
  });
});
