/**
 * Local Agent X — Browser Manager barrel.
 *
 * Real Chrome via CDP; helpers in src/browser/*.
 */

export type { BrowserEngine } from "./launcher.js";
export { withBrowserLock, getCurrentBrowserOwnerSessionId } from "./mutex.js";

export { getRecentDownloads } from "./downloads.js";
export { setBrowserAuthContext } from "./auth-context.js";
export { BrowserManager } from "./manager.js";
export type { BrowserBackend, InteractionResult, ScrollOptions } from "./backend.js";
export {
  registerSessionOwner,
  getSessionOwner,
  clearSessionOwner,
  resolveSessionBrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
} from "./session-owner-registry.js";
export type { SessionOwner } from "./session-owner-registry.js";
export { BrowserWedgeError } from "./observation.js";
export {
  getBrowserManager,
  getCdpBrowserManager,
  closeBrowser,
  closeAllBrowsers,
  resetWedgedBrowser,
  setCurrentBrowserSession,
} from "./instance.js";
