// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const panelSource = readFileSync(join(here, "../public/js/terminal-panel.js"), "utf8");
const switchSource = readFileSync(join(here, "../public/js/chat-artifacts.js"), "utf8");

function flush() { return Promise.resolve().then(() => Promise.resolve()); }

describe("terminal side panel", () => {
  let bridge: Record<string, ReturnType<typeof vi.fn>>;
  let input: ((data: string) => void) | null;
  let output: ((data: string) => void) | null;
  let exit: ((event: { exitCode: number }) => void) | null;
  let resizeCallback: (() => void) | null;
  let term: { cols: number; rows: number; write: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    document.body.innerHTML = `<button id="side-tab-agents"></button><button id="side-tab-artifacts"></button><button id="side-tab-browser"></button><button id="side-tab-terminal"></button><button id="agent-feeds-autoopen-toggle"></button><div id="agents-tab-body"></div><div id="artifacts-tab-body"></div><div id="browser-tab-body"></div><div id="terminal-tab-body" style="display:none"><button id="terminal-restart"></button><div id="terminal-host"></div><div id="terminal-unavailable" style="display:none"></div></div>`;
    input = null; output = null; exit = null; resizeCallback = null;
    bridge = {
      create: vi.fn().mockResolvedValue(undefined), write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn((cb) => { output = cb; return vi.fn(); }),
      onExit: vi.fn((cb) => { exit = cb; return vi.fn(); }),
    };
    term = { cols: 90, rows: 30, write: vi.fn(), focus: vi.fn(), dispose: vi.fn() };
    (window as unknown as { desktop?: unknown }).desktop = { terminal: bridge };
    (window as unknown as { Terminal: unknown }).Terminal = class {
      cols = term.cols; rows = term.rows; write = term.write; focus = term.focus; dispose = term.dispose;
      loadAddon() {} open() {} onData(cb: (data: string) => void) { input = cb; }
    };
    (window as unknown as { FitAddon: unknown }).FitAddon = { FitAddon: class { fit() {} } };
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class { constructor(cb: () => void) { resizeCallback = cb; } observe() {} disconnect() {} };
    (window as unknown as { laxBrowserTab: unknown }).laxBrowserTab = { onTabShown: vi.fn(), onTabHidden: vi.fn() };
    new Function(panelSource)();
    new Function(`${switchSource}\nwindow.switchSidePanelTab = switchSidePanelTab;`)();
  });

  it("creates lazily, forwards exact I/O, and resizes", async () => {
    expect(bridge.create).not.toHaveBeenCalled();
    (window as unknown as { switchSidePanelTab(tab: string): void }).switchSidePanelTab("terminal");
    await flush();
    expect(bridge.create).toHaveBeenCalledWith(90, 30);
    input!("\u001b[A");
    expect(bridge.write).toHaveBeenCalledWith("\u001b[A");
    output!("hello\r\n");
    expect(term.write).toHaveBeenCalledWith("hello\r\n");
    resizeCallback!();
    expect(bridge.resize).toHaveBeenCalledWith(90, 30);
  });

  it("shows terminal, hides browser, and restart disposes before recreating", async () => {
    const browser = (window as unknown as { laxBrowserTab: { onTabHidden: ReturnType<typeof vi.fn> } }).laxBrowserTab;
    (window as unknown as { switchSidePanelTab(tab: string): void }).switchSidePanelTab("terminal");
    await flush();
    expect(document.getElementById("terminal-tab-body")!.style.display).toBe("");
    expect(browser.onTabHidden).toHaveBeenCalled();
    document.getElementById("terminal-restart")!.click();
    await flush(); await flush();
    expect(bridge.dispose).toHaveBeenCalled();
    expect(bridge.create).toHaveBeenCalledTimes(2);
  });

  it("shows a non-desktop message without throwing", async () => {
    delete (window as unknown as { desktop?: unknown }).desktop;
    await (window as unknown as { laxTerminalPanel: { restart(): Promise<void> } }).laxTerminalPanel.restart();
    expect(document.getElementById("terminal-unavailable")!.style.display).toBe("grid");
  });

  it("recovers after PTY creation rejects", async () => {
    bridge.create.mockRejectedValueOnce(new Error("spawn failed"));
    await (window as unknown as { laxTerminalPanel: { restart(): Promise<void> } }).laxTerminalPanel.restart();
    expect(document.getElementById("terminal-unavailable")!.textContent).toContain("failed to start");
    await (window as unknown as { laxTerminalPanel: { restart(): Promise<void> } }).laxTerminalPanel.restart();
    expect(bridge.create).toHaveBeenCalledTimes(2);
    expect(term.focus).toHaveBeenCalledOnce();
  });

  it("does not reactivate a PTY that exits during creation", async () => {
    var resolveCreate: () => void = () => undefined;
    bridge.create.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveCreate = resolve; }));
    (window as unknown as { switchSidePanelTab(tab: string): void }).switchSidePanelTab("terminal");
    await flush();
    exit!({ exitCode: 1 });
    resolveCreate();
    await flush();
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("ignores stale startup completion after restart", async () => {
    var resolveFirst: () => void = () => undefined;
    bridge.create.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }));
    (window as unknown as { switchSidePanelTab(tab: string): void }).switchSidePanelTab("terminal");
    await flush();
    var restarted = (window as unknown as { laxTerminalPanel: { restart(): Promise<void> } }).laxTerminalPanel.restart();
    await flush();
    resolveFirst();
    await restarted;
    expect(bridge.create).toHaveBeenCalledTimes(2);
    expect(term.focus).toHaveBeenCalledOnce();
  });
});
