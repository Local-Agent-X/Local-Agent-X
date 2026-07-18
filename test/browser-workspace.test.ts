// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../public/js/browser-workspace.js"), "utf8");
const CSS = readFileSync(join(here, "../public/css/browser-workspace.css"), "utf8");
const ARTIFACTS_SRC = readFileSync(join(here, "../public/js/chat-artifacts.js"), "utf8");
const APP_STATE_SRC = readFileSync(join(here, "../public/js/app-state.js"), "utf8");
const CHAT_SEND_SRC = readFileSync(join(here, "../public/js/chat-send.js"), "utf8");
const VOICE_HANDLER_SRC = readFileSync(join(here, "../public/js/chat-voice-ws-handler.js"), "utf8");

function loadWorkspace(): void {
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
}

beforeEach(() => {
  history.replaceState({}, "", "/");
  document.head.innerHTML = "";
  document.body.className = "";
  document.body.innerHTML = `
    <div id="page-chat" class="active">
      <div id="chat-main"><div id="messages"><div class="msg assistant">Latest answer</div></div><div id="input-area"></div></div>
      <div id="agent-feeds" class="active">
        <div class="agent-feeds-header"><button id="side-tab-browser" class="active">BROWSER</button></div>
        <div id="browser-tab-body"><div id="browser-address-bar"></div><div id="browser-view-anchor"></div></div>
      </div>
    </div>`;
  Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
  (window as any).laxBrowserTab = { sync: vi.fn() };
  delete (window as any).desktop;
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
    expect(CSS).toContain("--browser-chat-dock-height:52px");
    expect(CSS).toContain("browser-chat-has-latest{--browser-chat-dock-height:84px}");
    expect(CSS).toContain("display:grid;grid-template-columns:");
    expect(CSS).toContain("height:28px!important");
    expect(CSS).toContain("body.browser-workspace #chat-main #context-bar,");
    expect(CSS).toContain("body.browser-workspace #chat-main #status-bar{display:none!important}");
    expect(CSS).toContain("background:transparent;box-shadow:none");
    expect(CSS).toContain("width:min(100%,840px)");
    expect(CSS).toContain("body.platform-win .browser-workspace-toggle{margin-right:0;transform:translateY(3px)}");
    expect(CSS).toContain("body.browser-workspace .agent-feeds-header{padding:7px 12px}");
    expect(CSS).toContain("#stop-btn{grid-column:8");
    expect(CSS).toContain("#send-btn{grid-column:9");
    expect(CSS).toContain("browser-chat-latest-open{--browser-chat-dock-height:min(38vh,380px)}");
    expect(CSS).toContain("body.browser-workspace #browser-tab-body{\n  padding-bottom:0");
    expect(CSS).toContain("body.browser-chat-overlay-renderer");
  });

  it("reserves a native overlay only for the compact chat card", async () => {
    const setChatOverlay = vi.fn().mockResolvedValue(undefined);
    (window as any).desktop = { browser: { setChatOverlay } };
    loadWorkspace();
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    });
    (document.getElementById("input-area") as any).getBoundingClientRect = () => rect(540, 950, 840, 50);
    (document.getElementById("browser-chat-dock-bar") as any).getBoundingClientRect = () => rect(1354, 952, 26, 24);

    (window as any).laxBrowserWorkspace.setActive(true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const payload = setChatOverlay.mock.calls.at(-1)?.[0];
    expect(payload.bounds).toEqual({ x: 540, y: 950, width: 840, height: 50 });
    expect(payload.overlayUrl).toContain("browserChatOverlay=1");
    expect(payload.bounds.width).toBeLessThan(1000);

    (window as any).laxBrowserWorkspace.setActive(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(setChatOverlay).toHaveBeenLastCalledWith(null);
  });

  it("routes overlay controls to the host that owns native bounds", async () => {
    const OriginalBroadcastChannel = (window as any).BroadcastChannel;
    const channels: Array<{ onmessage?: (event: { data: any }) => void; postMessage: ReturnType<typeof vi.fn> }> = [];
    class FakeBroadcastChannel {
      onmessage?: (event: { data: any }) => void;
      postMessage = vi.fn();
      constructor(_name: string) { channels.push(this); }
    }
    (window as any).BroadcastChannel = FakeBroadcastChannel;
    const setChatOverlay = vi.fn().mockResolvedValue(undefined);
    (window as any).desktop = { browser: { setChatOverlay } };
    loadWorkspace();
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, width, height, right: left + width, bottom: top + height,
    });
    (document.getElementById("input-area") as any).getBoundingClientRect = () => rect(540, 950, 840, 50);
    (document.getElementById("browser-chat-latest") as any).getBoundingClientRect = () => rect(600, 920, 720, 28);
    (document.getElementById("messages") as any).getBoundingClientRect = () =>
      document.body.classList.contains("browser-chat-latest-open") ? rect(600, 600, 720, 320) : rect(0, 0, 0, 0);
    (window as any).laxBrowserWorkspace.setActive(true);

    channels[0].onmessage?.({ data: {
      type: "browser-workspace-control", control: "latestOpen", value: true,
    } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.body.classList.contains("browser-chat-latest-open")).toBe(true);
    expect(setChatOverlay.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      bounds: { x: 540, y: 600, width: 840, height: 400 }, latestOpen: true,
    }));
    (window as any).BroadcastChannel = OriginalBroadcastChannel;
  });

  it("sends expanded and collapsed overlay clicks back to the host", () => {
    const OriginalBroadcastChannel = (window as any).BroadcastChannel;
    const channels: Array<{ postMessage: ReturnType<typeof vi.fn> }> = [];
    class FakeBroadcastChannel {
      postMessage = vi.fn();
      constructor(_name: string) { channels.push(this); }
    }
    history.replaceState({}, "", "/?browserChatOverlay=1");
    (window as any).BroadcastChannel = FakeBroadcastChannel;
    (window as any).desktop = { browser: { onChatOverlayState: vi.fn() } };
    loadWorkspace();

    (document.getElementById("browser-chat-latest") as HTMLButtonElement).click();
    (document.getElementById("browser-chat-collapse") as HTMLButtonElement).click();

    expect(channels[0].postMessage).toHaveBeenNthCalledWith(1, {
      type: "browser-workspace-control", control: "latestOpen", value: true,
    });
    expect(channels[0].postMessage).toHaveBeenNthCalledWith(2, {
      type: "browser-workspace-control", control: "collapsed", value: true,
    });
    (window as any).BroadcastChannel = OriginalBroadcastChannel;
  });

  it("hands user messages from the overlay renderer back to the host chat", () => {
    expect(CHAT_SEND_SRC).toContain("broadcastChatUserMessage(activeChat.id, userMessage)");
    expect(VOICE_HANDLER_SRC).toContain("broadcastChatUserMessage(activeChat.id, userMessage)");
    const OriginalBroadcastChannel = (window as any).BroadcastChannel;
    const channels: Array<{ onmessage?: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> }> = [];
    class FakeBroadcastChannel {
      onmessage?: (event: { data: unknown }) => void;
      postMessage = vi.fn();
      constructor(_name: string) { channels.push(this); }
    }
    (window as any).BroadcastChannel = FakeBroadcastChannel;
    localStorage.setItem("lax_chats_v2", JSON.stringify([{
      id: "chat-1", title: "New Chat", createdAt: 1, updatedAt: 1, messages: [],
    }]));
    (window as any).renderMessages = vi.fn();
    (window as any).renderSidebar = vi.fn();

    new Function(APP_STATE_SRC)();
    const message = { role: "user", content: "keep this turn", timestamp: 2 };
    (window as any).broadcastChatUserMessage("chat-1", message);

    expect(channels[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "user-message", sessionId: "chat-1", message: expect.objectContaining({ _rendererSyncId: expect.any(String) }),
    }));
    channels[0].onmessage?.({ data: {
      type: "user-message", sessionId: "chat-1", title: "Keep this turn", message: { ...message, _rendererSyncId: "remote-1" },
    } });
    expect((window as any).renderMessages).not.toHaveBeenCalled();
    expect((window as any).renderSidebar).toHaveBeenCalledOnce();
    (window as any).BroadcastChannel = OriginalBroadcastChannel;
    delete (window as any).broadcastChatUserMessage;
    delete (window as any).renderMessages;
    delete (window as any).renderSidebar;
  });

  it("expands the existing latest assistant turn and closes it on collapse", () => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    loadWorkspace();
    (window as any).laxBrowserWorkspace.setActive(true);
    const messages = document.getElementById("messages");
    const latest = document.getElementById("browser-chat-latest") as HTMLButtonElement;

    expect(getComputedStyle(messages as HTMLElement).display).toBe("none");
    latest.click();
    expect(document.body.classList.contains("browser-chat-latest-open")).toBe(true);
    expect(latest.getAttribute("aria-expanded")).toBe("true");
    expect(latest.getAttribute("aria-label")).toBe("Hide latest turn");
    expect(messages?.querySelector(".browser-latest-turn")?.textContent).toBe("Latest answer");
    expect(document.querySelectorAll("#messages")).toHaveLength(1);
    expect(getComputedStyle(messages as HTMLElement).display).toBe("flex");
    expect(getComputedStyle(messages?.querySelector(".browser-latest-turn") as HTMLElement).display).toBe("block");

    (window as any).laxBrowserWorkspace.setCollapsed(true);
    expect(document.body.classList.contains("browser-chat-latest-open")).toBe(false);
    expect((window as any).laxBrowserWorkspace.isLatestOpen()).toBe(false);
  });

  it("omits the latest-turn strip when the chat has no assistant reply", () => {
    document.querySelector("#messages .msg")?.remove();
    loadWorkspace();
    (window as any).laxBrowserWorkspace.setActive(true);

    expect((document.getElementById("browser-chat-latest") as HTMLButtonElement).hidden).toBe(true);
    expect(document.body.classList.contains("browser-chat-has-latest")).toBe(false);
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
