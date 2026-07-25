/**
 * Connector to the embedded Electron browser's loopback CDP endpoint.
 *
 * The desktop shell opens a Chromium-chosen, loopback-only remote-debugging
 * port and hands it to this server child as LAX_ELECTRON_CDP_PORT (C1). This
 * module connects Playwright to that endpoint so the browser backend can drive
 * the in-app WebContentsViews with full-fidelity Page primitives instead of the
 * legacy bridge. It reuses the external-Chrome connect pattern from
 * launcher.ts (pw.chromium.connectOverCDP) but never spawns a process — the
 * Electron app owns the browser.
 *
 * Failure is never fatal here: every entry point returns null (never throws) so
 * a caller can fall back to the legacy bridge when the endpoint is absent (env
 * unset) or the connect fails. This chunk only provides the connector; wiring
 * it into the BrowserBackend is a later chunk.
 */
import type { Browser, Page } from "playwright";
import { createLogger } from "../logger.js";

const logger = createLogger("browser.electron-cdp");

/**
 * Opens a Playwright Browser over a CDP endpoint URL. Injectable so tests can
 * supply a fake browser and never open a real socket. The default performs the
 * same connectOverCDP the external-Chrome path uses.
 */
export type CdpConnector = (cdpUrl: string) => Promise<Browser>;

// The endpoint is first-party loopback: a ready endpoint connects in well
// under a second. Playwright's 30s default would instead pin the FIRST caller
// (e.g. an agent navigate) for 30s whenever the endpoint isn't up yet before
// falling back to the legacy bridge — a cold-start freeze. Bound it so a
// not-yet-ready endpoint fails fast (→ bridge fallback) and native driving
// picks up on a later call once the endpoint is live.
const CDP_CONNECT_TIMEOUT_MS = 5000;

const defaultConnector: CdpConnector = async (cdpUrl) => {
  const pw = await import("playwright");
  return pw.chromium.connectOverCDP(cdpUrl, { timeout: CDP_CONNECT_TIMEOUT_MS });
};

let connector: CdpConnector = defaultConnector;
let cached: Browser | null = null;
let connecting: Promise<Browser | null> | null = null;

/**
 * Lazy singleton connection to the embedded Electron CDP endpoint. Returns the
 * cached Browser, or null when the endpoint is unavailable — env unset or the
 * connect failed. Never throws. Concurrent callers share one in-flight connect.
 */
export async function connectElectronCdp(): Promise<Browser | null> {
  if (cached) {
    if (cached.isConnected()) return cached;
    // A dropped connection (endpoint closed, app quit) must not be handed back.
    cached = null;
  }
  if (connecting) return connecting;

  const portRaw = process.env.LAX_ELECTRON_CDP_PORT;
  const port = portRaw ? Number(portRaw) : NaN;
  if (!portRaw || !Number.isInteger(port) || port <= 0) {
    // No endpoint — the caller falls back to the legacy bridge. Not an error.
    return null;
  }

  // Only the first-party loopback endpoint is ever contacted — no other host.
  const cdpUrl = `http://127.0.0.1:${port}`;
  connecting = (async () => {
    try {
      const browser = await connector(cdpUrl);
      cached = browser;
      // Drop the cache on disconnect so a later call reconnects instead of
      // handing back a dead handle.
      browser.on("disconnected", () => { if (cached === browser) cached = null; });
      // Port is intentionally not logged (see C1 — it is never logged).
      logger.info("connected to embedded Electron CDP endpoint");
      return browser;
    } catch (err) {
      logger.warn(`connect to embedded Electron CDP failed: ${(err as Error).message}`);
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/**
 * Resolve the Playwright Page for the Electron WebContentsView with this
 * viewId, or null if not found / not connected. The view stamps a per-view
 * marker (window.name === viewId) on its top frame at creation
 * (desktop/src/browser-views.ts); we read it back over CDP to map the id to a
 * Page. Never throws.
 */
export async function getPageForView(viewId: string): Promise<Page | null> {
  const browser = await connectElectronCdp();
  if (!browser) return null;
  try {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          // String form (not a function) to avoid a DOM lib dependency — same
          // convention as fingerprintPage/scrollPage in this package.
          const name = await page.evaluate("window.name");
          if (name === viewId) return page;
        } catch {
          // A page can navigate or close mid-scan — skip it, don't fail lookup.
        }
      }
    }
  } catch (err) {
    logger.warn(`getPageForView(${viewId}) failed: ${(err as Error).message}`);
    return null;
  }
  return null;
}

/**
 * Close and forget the cached connection (teardown). Detaches Playwright from
 * the endpoint without killing the Electron-owned browser. Never throws.
 */
export async function closeElectronCdp(): Promise<void> {
  const browser = cached;
  cached = null;
  connecting = null;
  if (!browser) return;
  try {
    await browser.close();
  } catch (err) {
    logger.warn(`closeElectronCdp failed: ${(err as Error).message}`);
  }
}

/**
 * Test seam: override the CDP connector (pass null to restore the default).
 * Also clears any cached connection so the next connect uses the new connector.
 */
export function _setConnectorForTest(fn: CdpConnector | null): void {
  connector = fn ?? defaultConnector;
  cached = null;
  connecting = null;
}
