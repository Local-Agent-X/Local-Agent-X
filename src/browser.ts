/**
 * Local Agent X — Browser Manager barrel.
 *
 * Real Chrome via CDP; helpers in src/browser/*.
 */

export type { BrowserEngine } from "./browser/launcher.js";
export { withBrowserLock, getCurrentBrowserOwnerSessionId } from "./browser/mutex.js";

export { recentDownloads, getRecentDownloads } from "./browser/downloads.js";
export { setBrowserAuthContext } from "./browser/auth-context.js";
export { BrowserManager } from "./browser/manager.js";
export {
  getBrowserManager,
  closeBrowser,
  closeAllBrowsers,
  setCurrentBrowserSession,
} from "./browser/instance.js";
