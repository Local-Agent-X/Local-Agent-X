/**
 * The standing "you are not reading the user's window" banner.
 *
 * A device-emulation profile is a process-lifetime Map entry keyed by the
 * resolved browser session id. NOTHING in the chat/session lifecycle clears it:
 * an operation that ends while emulating leaves the chat emulated, and the
 * user's NEXT message drives the private headless phone context while the
 * window in front of them does nothing. The route line
 * (route-resolve.reportBrowserRoute) is logger output — the model never sees it.
 *
 * The answer chosen here is to tell the MODEL, at the moment of use, on every
 * browser action: an emulated session cannot take a single reading without
 * being told what it is reading. That is strictly stronger than a turn-start
 * notice for this failure mode (a turn-start line can be many messages stale by
 * the time the action runs), and it does not require touching the canonical
 * loop. `emulate` itself is exempt — its own result says all of this.
 */

import { getSessionEmulation } from "../../browser/emulation.js";
import { resolveBrowserSessionId } from "../../browser/session-owner-registry.js";

/** Deliberately carries NO viewport numbers. It rides above results that report
 *  measured geometry (layout_report is the whole reason emulate exists), and a
 *  profile's 390x844 sitting above a report whose clientWidth is something else
 *  is the confusion layout_report's own no-preamble rule exists to prevent. The
 *  emulate result and `info` are where the profile's numbers belong. */
export function emulationBanner(sessionId: string, action: string): string | null {
  if (action === "emulate") return null;
  if (!getSessionEmulation(resolveBrowserSessionId(sessionId || "default"))) return null;
  return (
    "[emulating] A device-emulation profile is installed, so this session is on its PRIVATE emulated " +
    "context — not the browser window the user is looking at. That window still shows whatever it showed " +
    "before, this context has no cookies or logins, and `tabs` here does not list the user's tabs. Run " +
    "browser {action:\"emulate\", device:\"desktop\"} to close it and go back."
  );
}
