// May the agent reach this device on the user's own network?
//
// A device on the LAN (a router, a NAS, a printer, the cloud metadata address
// on a cloud server) is refused until the user allows it, and the refusal
// carries the allow-host action, so the chat offers "Allow <device> & retry".
// Allowing it puts it on the web-access allowlist (egress-policy-state.ts),
// the same list strict mode and the trusted-destination checks read, so an
// allowed router can also receive its own {{ROUTER_PASSWORD}}.
//
// Owner ruling 2026-11-24: an assistant that refuses the user's own router
// with no way out is wrong; ask, don't block. What stays refused outright:
// loopback and this machine's own addresses (their grant is per port, in
// loopback-grant.ts: allowing them by host would open every local port,
// the in-app browser's driver among them), encoded addresses, and reserved
// space nothing the user owns lives in.

import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import { isLanAddress, isLocalNetworkName } from "./ip-classification.js";
import { matchEgressList } from "./host-list.js";
import { isThisMachineHost } from "./loopback-grant.js";

const CLOUD_METADATA_ADDRESS = "169.254.169.254";

function refusalText(host: string): string {
  if (host === CLOUD_METADATA_ADDRESS) {
    return `Blocked: ${host} is the cloud metadata address; on a cloud server it hands out the machine's own credentials. Only the user can allow it, from this block's notice or in Settings → Security → Web access.`;
  }
  return `Blocked: ${host} is a device on a local network the user has not allowed. The user can allow it from this block's notice or in Settings → Security → Web access; tell them which device you need and why.`;
}

/**
 * The decision for a local-network destination, or null when `host` (already
 * canonicalized) is not one and the rest of the egress policy decides. An
 * allowlisted device is allowed in either web-access mode.
 */
export function localNetworkDecision(host: string, allowlist: ReadonlySet<string>): SecurityDecision | null {
  if (isThisMachineHost(host)) return null;
  if (!isLanAddress(host) && !isLocalNetworkName(host)) return null;
  if (matchEgressList(host, allowlist)) return { allowed: true, reason: `Allowed local-network device ${host}` };
  return { allowed: false, reason: refusalText(host), userHint: USER_HINTS.network, action: { kind: "allow-host", host } };
}
