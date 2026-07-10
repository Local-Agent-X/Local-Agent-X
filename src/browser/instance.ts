import type { Page } from "playwright";
import { BrowserManager } from "./manager.js";
import { closeSharedBrowser, forceKillSharedBrowser } from "./runtime.js";
import { getRuntimeConfig } from "../config.js";

// One Chrome process, one BrowserManager per session. Each manager owns its
// own tabs + observation registry (see manager.ts), so concurrent sessions —
// e.g. a chat and a scheduled mission — never stomp each other's page or refs.
// Cookies are isolated across sessions unless browserPerSessionContext is
// explicitly turned off for continuity.
const managers = new Map<string, BrowserManager>();

function peerPagesExcept(self: BrowserManager): Page[] {
  const pages: Page[] = [];
  for (const m of managers.values()) {
    if (m !== self) pages.push(...m.listOwnedPages());
  }
  return pages;
}

export function getBrowserManager(sessionId: string = "default"): BrowserManager {
  const key = sessionId || "default";
  let manager = managers.get(key);
  if (!manager) {
    const isolated = getRuntimeConfig().browserPerSessionContext === true;
    manager = new BrowserManager(key, isolated);
    manager.setPeerPages(() => peerPagesExcept(manager!));
    manager.setIdleHandler(() => {
      if (managers.get(key) === manager) managers.delete(key);
      if (managers.size === 0) void closeSharedBrowser();
    });
    managers.set(key, manager);
  }
  return manager;
}

export async function closeBrowser(sessionId: string = "default"): Promise<void> {
  const key = sessionId || "default";
  const manager = managers.get(key);
  if (manager) {
    managers.delete(key);
    await manager.close();
  }
  if (managers.size === 0) await closeSharedBrowser();
}

/**
 * In-process wedge recovery (no LAX restart). When a browser action hangs and
 * its deadline fires, drop the offending session's manager and force-kill the
 * shared Chrome. Every session's cached page now points at a dead connection,
 * so the next browser call re-launches a fresh Chrome and rebuilds its tabs
 * (BrowserManager.getPage's liveness check catches the dead page and
 * re-acquires). Synchronous + force: we must NOT await graceful teardown on a
 * wedged connection — that can hang too.
 */
export function resetWedgedBrowser(sessionId: string = "default"): void {
  const key = sessionId || "default";
  managers.delete(key);
  forceKillSharedBrowser();
}

export async function closeAllBrowsers(): Promise<void> {
  const all = [...managers.values()];
  managers.clear();
  for (const m of all) {
    try { await m.close(); } catch { /* already closed */ }
  }
  await closeSharedBrowser();
}

// Backwards compat — session ID now passed directly to getBrowserManager.
export function setCurrentBrowserSession(_sessionId: string): void {}
