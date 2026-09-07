/**
 * The three "not supported here" strings BrowserManager returns for
 * read_console / read_network / read_response.
 *
 * They live here because the honest answer depends on WHY the session is on a
 * CDP manager, and there are two very different whys:
 *
 *   - The session really is on external Chrome. Console/network capture rides
 *     the desktop's WebContentsView plumbing, which that backend does not have.
 *   - The session is on the IN-APP route but is EMULATING, so its page actions
 *     were redirected to the private emulated context (emulation-route.ts).
 *     The in-app browser is right there and its capture plumbing is fine — the
 *     emulated context is what cannot report.
 *
 * The old text named only the first cause. An emulating agent read "it is
 * available in the in-app browser", concluded the desktop bridge had dropped,
 * and debugged the bridge. One rule, one statement: the cause named here is the
 * cause the routing seam actually applied.
 */

import { describeEmulation, getSessionEmulation } from "./emulation.js";

function emulationPrefix(ownerId: string): string | null {
  const profile = getSessionEmulation(ownerId);
  if (!profile) return null;
  return (
    "not available while this session is emulating a device: a device-emulation profile " +
    `(${describeEmulation(profile).split("\n")[0]}) redirected this session's page actions to a private ` +
    "headless context, and capture rides the in-app browser's plumbing, not that context. " +
    "Run emulate with device='desktop' to close the emulated context and put this session back on the " +
    "in-app browser view, then read again."
  );
}

export function consoleCaptureRefusal(ownerId: string): string {
  const emulating = emulationPrefix(ownerId);
  if (emulating) return `Console capture is ${emulating}`;
  return (
    "Console capture is not supported on the external-Chrome backend — " +
    "it is available in the in-app browser. No console output was read."
  );
}

export function networkCaptureRefusal(ownerId: string): string {
  const emulating = emulationPrefix(ownerId);
  if (emulating) return `Network capture is ${emulating}`;
  return (
    "Network capture is not supported on the external-Chrome backend — " +
    "it is available in the in-app browser. No network activity was read."
  );
}

export function responseCaptureRefusal(ownerId: string): string {
  const emulating = emulationPrefix(ownerId);
  if (emulating) return `Response-body capture is ${emulating}`;
  return (
    "Response-body capture is not supported on the external-Chrome backend — " +
    "it is available in the in-app browser. Use http_request to fetch the URL instead."
  );
}
