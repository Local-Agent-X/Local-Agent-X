// Long-lived host grants — issued once at startup, used for the whole
// process lifetime. Same lease shape as any other grant, but with
// effectively unbounded maxCalls and a far-future expiry because the
// host's entitlement does not change at runtime.
//
// Grants are minted directly rather than via firewall.requestCapability()
// because the issuer's default lease (5 minutes / 10 calls) would force
// either per-request re-issuance or silent re-mints — both forbidden by
// the manifest model. The host principal is its own grant authority
// for the actions it has declared up-front.

import { CAPABILITY_CLASS_MAP, deriveCapabilityClass, generateId, now } from "@arikernel/core";
import type { CapabilityClass, CapabilityGrant } from "@arikernel/core";
import type { TokenStore } from "@arikernel/runtime";
import { HOST_CAPABILITY_MANIFEST } from "./manifest.js";
import { getHostGrants } from "./state.js";

const HOST_GRANT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function mintHostGrants(
  store: TokenStore,
  principalId: string,
): Map<CapabilityClass, string> {
  const capClasses = new Set<CapabilityClass>();
  for (const { toolClass, action } of HOST_CAPABILITY_MANIFEST) {
    const capClass = deriveCapabilityClass(toolClass, action);
    const mapping = CAPABILITY_CLASS_MAP[capClass];
    // Only protected (toolClass, action) pairs need a grant. Unprotected
    // pairs (e.g. retrieval.search) pass the pipeline's capability gate
    // without a grant and only need the principal declaration.
    if (
      mapping &&
      mapping.toolClass === toolClass &&
      mapping.actions.includes(action.toLowerCase())
    ) {
      capClasses.add(capClass);
    }
  }
  const issuedAt = now();
  const expiresAt = new Date(Date.now() + HOST_GRANT_TTL_MS).toISOString();
  const map = new Map<CapabilityClass, string>();
  for (const capClass of capClasses) {
    const grant: CapabilityGrant = {
      id: generateId(),
      requestId: generateId(),
      principalId,
      capabilityClass: capClass,
      constraints: {},
      lease: {
        issuedAt,
        expiresAt,
        maxCalls: Number.MAX_SAFE_INTEGER,
        callsUsed: 0,
      },
      taintContext: [],
      revoked: false,
    };
    store.store(grant);
    map.set(capClass, grant.id);
  }
  return map;
}

// Look up the grantId to attach to a tool call. Returns undefined when the
// (toolClass, action) pair is not protected by CAPABILITY_CLASS_MAP — in
// that case the pipeline's capability gate is a no-op and passing a
// grantId would actually fail validateToken (since the action wouldn't be
// in the grant's capability class action list).
export function lookupHostGrantId(toolClass: string, action: string): string | undefined {
  const capClass = deriveCapabilityClass(toolClass, action);
  const mapping = CAPABILITY_CLASS_MAP[capClass];
  if (!mapping || mapping.toolClass !== toolClass) return undefined;
  if (!mapping.actions.includes(action.toLowerCase())) return undefined;
  return getHostGrants().get(capClass);
}
