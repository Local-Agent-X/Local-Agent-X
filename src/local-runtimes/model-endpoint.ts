/**
 * Is `baseUrl` serving a LOCAL model — one the local-model request rules
 * apply to: the output cap (local-cap.ts: the LOCAL_DEFAULT_MAX_TOKENS default
 * and the window-aware clamp), the degenerate-stream guard, and the
 * thinking-off switch?
 *
 *   loopback / private-IP literal → yes (the zero-config case)
 *   a runtime the operator added by hand (settings.localRuntimes) → yes, by
 *     its exact host:port, the same identity admission.ts admits it on. A
 *     named host (a LAN box, `host.docker.internal` from a container) is not
 *     an IP literal, so a URL-shape check alone treated it as a cloud
 *     endpoint: no output cap, and a thinking model on it generated until the
 *     whole context was full (Terminal-Bench, 2026-10-18).
 *
 * Model behavior only. Facts about THIS machine (its GPU, for context sizing)
 * and security decisions (local-only mode, egress) stay on isLoopbackUrl: a
 * LAN runtime does not run on this machine's GPU.
 */
import { isLoopbackOrPrivateUrl } from "../local-only-policy.js";
import { endpointHostPort } from "./admission.js";
import { manualAllowlist } from "./endpoints.js";

export function isLocalModelEndpoint(baseUrl: string | undefined, settings?: Record<string, unknown>): boolean {
  if (!baseUrl) return false;
  if (isLoopbackOrPrivateUrl(baseUrl)) return true;
  const hostPort = endpointHostPort(baseUrl);
  if (!hostPort) return false;
  try {
    return (settings ? manualAllowlist(settings) : manualAllowlist()).has(hostPort);
  } catch {
    // Settings unreadable: no operator entry can be shown to match.
    return false;
  }
}
