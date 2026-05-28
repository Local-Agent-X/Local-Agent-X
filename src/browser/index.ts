/**
 * Local Agent X — Browser Manager barrel.
 *
 * Real Chrome via CDP; helpers in src/browser/*.
 */

export type { BrowserEngine } from "./launcher.js";
export { withBrowserLock, getCurrentBrowserOwnerSessionId } from "./mutex.js";

export { recentDownloads, getRecentDownloads } from "./downloads.js";
export { setBrowserAuthContext } from "./auth-context.js";
export { BrowserManager } from "./manager.js";
export {
  getBrowserManager,
  closeBrowser,
  closeAllBrowsers,
  setCurrentBrowserSession,
} from "./instance.js";
