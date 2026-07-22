/**
 * Local Agent X — Browser barrel.
 *
 * Two backends behind one contract: an embedded co-drivable WebContentsView
 * (the default) and external Chrome over CDP (the fallback). getBrowserManager
 * routes; see instance.ts. Helpers in src/browser/*.
 */

export type { BrowserEngine } from "./launcher.js";
export { withBrowserLock, getCurrentBrowserOwnerSessionId } from "./mutex.js";

export { getRecentDownloads } from "./downloads.js";
export { setBrowserAuthContext } from "./auth-context.js";
export { BrowserManager } from "./manager.js";
export type { BrowserBackend, InteractionResult, ScrollOptions } from "./backend.js";
export type { ScreenshotImage, ScreenshotResult } from "./page-ops.js";
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
  getSecretBrowserOps,
  closeBrowser,
  closeAllBrowsers,
  resetWedgedBrowser,
  setCurrentBrowserSession,
} from "./instance.js";
export type { WedgeRecoveryOutcome } from "./instance.js";
export type {
  SecretBrowserOps,
  SecretElementDescriptor,
  SecretFillOutcome,
  SecretReadTarget,
} from "./secret-ops.js";
