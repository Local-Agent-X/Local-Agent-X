/**
 * Egress-proxy env for sandboxed shells — guarded mode only.
 *
 * Guarded is the one sandbox mode where a shell keeps network access, so it is
 * the one mode that gets pointed at the shell egress proxy (the sanctioned
 * route, observe-only until the cage enforces). Strict seatbelt/bwrap deny all
 * network — no route exists to proxy; docker runs --network=none; host is
 * intentionally uncaged and gets no proxy.
 *
 * This module is the ONLY place that decides proxy-env-vs-not; both spawn
 * paths (bash tool, process_* sessions) feed its result through the `extra`
 * overlay of buildSanitizedEnv, the sanctioned seam that sets keys verbatim.
 */
import { getSandboxMode } from "../sandbox/index.js";
import {
  currentShellEgressProxyUrl,
  ensureShellEgressProxy,
} from "../net/shell-egress-proxy.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tools.shell-proxy-env");

// Loopback must bypass the proxy: dev servers, ollama, and the app's own API
// live there, and the proxy's policy would only see hairpin traffic.
const NO_PROXY_HOSTS = "localhost,127.0.0.1,::1";

function proxyEnvFor(url: string): Record<string, string> {
  // Lowercase variants are load-bearing: many unix tools (curl honors both,
  // wget/git/python-requests read the lowercase forms) ignore the uppercase.
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: NO_PROXY_HOSTS,
    no_proxy: NO_PROXY_HOSTS,
  };
}

// No env is stored here — deliberately. The proxy singleton's live URL mirror
// (currentShellEgressProxyUrl) is the ONE source of truth, cleared the moment
// the listener dies (local-only teardown, failed start). A cached env here
// once outlived a teardown and pointed every subsequent spawn at a dead —
// and, worse, OS-recyclable — port. Derive fresh on every call.

/**
 * Env overlay routing a guarded shell's traffic through the egress proxy.
 * Returns {} for every other sandbox mode, and {} if the proxy cannot start.
 *
 * Never throws. The failure branch is NOT a silent-fallback violation: the
 * CAGE is the enforcement layer (once it enforces, off-machine traffic dies
 * at seatbelt/bwrap regardless of env), and this env is merely the sanctioned
 * route — so its absence fails CLOSED at the OS, not open. We log the
 * consequence and let the shell run.
 */
export async function shellProxyEnv(): Promise<Record<string, string>> {
  if (getSandboxMode() !== "guarded") return {};
  try {
    const proxy = await ensureShellEgressProxy();
    return proxyEnvFor(proxy.url);
  } catch (e) {
    logger.warn(
      `shell egress proxy failed to start; guarded shells run without a sanctioned egress route: ${(e as Error).message}`,
    );
    return {};
  }
}

/**
 * Synchronous variant for spawn paths that cannot await (startSession is sync
 * — its injected seam in dev-server.ts types it sync). Reads the singleton's
 * live URL mirror: proxy up → env derived fresh from the live URL; proxy down
 * (never started, or torn down by local-only mode) → warms the proxy in the
 * background and returns {} — that one spawn runs without the sanctioned
 * route, which fails closed at the cage (see shellProxyEnv), and spawns after
 * the warm settles get the env for whichever port the restart bound.
 */
export function shellProxyEnvSync(): Record<string, string> {
  if (getSandboxMode() !== "guarded") return {};
  const url = currentShellEgressProxyUrl();
  if (url) return proxyEnvFor(url);
  void shellProxyEnv(); // never rejects — see its failure branch
  return {};
}
