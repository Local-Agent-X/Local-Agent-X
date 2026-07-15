/**
 * Admission gate for local-runtime endpoints — LAX-side, pure.
 *
 * Decides whether LAX itself may PROBE and route chat to an endpoint.
 * This is deliberately not the agent-tool egress gate in
 * security/layer/network-policy.ts: that gate polices the AGENT's tool
 * calls and its localServicePorts check only ever widens loopback (the
 * port test runs inside a literal-loopback host guard). Registering an
 * inference endpoint is an operator config action, so it gets its own
 * gate with its own invariant:
 *
 *   loopback     → always admitted (the default, zero-config case)
 *   non-loopback → admitted ONLY on an exact host:port match against
 *                  entries the user added by hand. No private-IP-range
 *                  carve-out — an injected agent must not be able to
 *                  reach a host the operator never named.
 */
import { isLoopbackUrl } from "../local-only-policy.js";

export interface AdmissionDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Normalize a URL to its "host:port" identity for allowlist matching.
 * Returns null for anything unparseable or non-http(s). Explicit port
 * required in the allowlist entry — default-port guessing is how exact
 * matching quietly becomes prefix matching.
 */
export function endpointHostPort(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return `${host}:${port}`;
  } catch {
    return null;
  }
}

/**
 * May LAX probe / route chat to this endpoint?
 *
 * @param manualAllowlist exact "host:port" entries the operator added by
 *   hand (persisted in settings; folded into security.json's local-service
 *   carve-out separately so the agent's own HTTP tools agree).
 */
export function admitEndpoint(
  baseUrl: string,
  manualAllowlist: ReadonlySet<string>,
): AdmissionDecision {
  const hostPort = endpointHostPort(baseUrl);
  if (!hostPort) {
    return { allowed: false, reason: "not a valid http(s) endpoint URL" };
  }
  if (isLoopbackUrl(baseUrl)) {
    return { allowed: true, reason: "loopback endpoint" };
  }
  if (manualAllowlist.has(hostPort)) {
    return { allowed: true, reason: `operator-allowlisted endpoint ${hostPort}` };
  }
  return {
    allowed: false,
    reason: `non-loopback endpoint ${hostPort} is not in the operator allowlist`,
  };
}
