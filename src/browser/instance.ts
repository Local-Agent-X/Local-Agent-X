import { BrowserManager } from "./manager.js";

// Chrome can only open one user-data-dir at a time, so all sessions/agents
// share a single browser with separate tabs.
let sharedInstance: BrowserManager | null = null;

export function getBrowserManager(_sessionId: string = "default"): BrowserManager {
  if (!sharedInstance) sharedInstance = new BrowserManager();
  return sharedInstance;
}

export async function closeBrowser(_sessionId: string = "default"): Promise<void> {
  if (sharedInstance) {
    await sharedInstance.close();
    sharedInstance = null;
  }
}

export async function closeAllBrowsers(): Promise<void> {
  if (sharedInstance) {
    await sharedInstance.close();
    sharedInstance = null;
  }
}

// Backwards compat — no-op, session ID now passed directly.
export function setCurrentBrowserSession(_sessionId: string): void {}
