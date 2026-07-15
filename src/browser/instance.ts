import type { Page } from "playwright";
import { BrowserManager } from "./manager.js";
import type { BrowserBackend } from "./backend.js";
import { resolveSessionBrowserProfileId } from "./session-owner-registry.js";
import { closeSharedBrowser, forceKillSharedBrowser } from "./runtime.js";
import { getRuntimeConfig } from "../config.js";

// One Chrome process, one BrowserManager per session. Each manager owns its
// own tabs + observation registry (see manager.ts), so concurrent sessions —
// e.g. a chat and a scheduled mission — never stomp each other's page or refs.
// Identity ownership is selected explicitly by browserMode.
const managers = new Map<string, BrowserManager>();

function peerPagesExcept(self: BrowserManager): Page[] {
  const pages: Page[] = [];
  for (const m of managers.values()) {
    if (m !== self) pages.push(...m.listOwnedPages());
  }
  return pages;
}

function ensureManager(sessionId: string): BrowserManager {
  const key = sessionId || "default";
  let manager = managers.get(key);
  if (!manager) {
    // Resolve the session's browser profile (3-rung winner, pre-computed at
    // run-prep) and bind the manager to it. CDP behavior is unchanged — the
    // profile is carried for the in-app backend + CDP userDataDir twin later.
    const profileId = resolveSessionBrowserProfileId(key);
    manager = new BrowserManager(key, getRuntimeConfig().browserMode, profileId);
    manager.setPeerPages(() => peerPagesExcept(manager!));
    manager.setIdleHandler(() => {
      if (managers.get(key) === manager) managers.delete(key);
      if (managers.size === 0) void closeSharedBrowser();
    });
    managers.set(key, manager);
  }
  return manager;
}

// Returns BrowserBackend — the tool-facing contract. Concretely a
// BrowserManager (CDP) today; the profile-bound ElectronInAppBackend routes
// through here in a later phase. Callers depend on the interface, not the class.
export function getBrowserManager(sessionId: string = "default"): BrowserBackend {
  return ensureManager(sessionId);
}

/**
 * Concrete-typed accessor for CDP-internal helpers that need the Playwright
 * `Page` (secret-fill / secret-capture operate directly on the page). Not part
 * of the tool-facing BrowserBackend contract — the in-app backend has no
 * Playwright page and grows its own secret-handling path in a later phase.
 */
export function getCdpBrowserManager(sessionId: string = "default"): BrowserManager {
  return ensureManager(sessionId);
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
  let teardownError: unknown;
  for (const m of all) {
    try { await m.close(); } catch (error) { teardownError ??= error; }
  }
  try { await closeSharedBrowser(); } catch (error) { teardownError ??= error; }
  if (teardownError) throw teardownError;
}

// Backwards compat — session ID now passed directly to getBrowserManager.
export function setCurrentBrowserSession(_sessionId: string): void {}
