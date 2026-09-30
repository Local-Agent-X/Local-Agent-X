// The operator's web-access policy as the security layer holds it: the mode
// (strict = only allowlisted hosts; permissive = any public host, the
// SSRF/denylist rules still apply) and the allowlist. Loaded once at start,
// changed only through the two setters, which persist to the same files the
// standalone readers (loadEgressConfig, the proxies, the browser worker) read,
// so every path sees one policy.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getLaxDir } from "../../lax-data-dir.js";
import { atomicWriteFileSync } from "../../util/json-store.js";
import { loadEgressAllowlist, loadEgressMode } from "./security-config.js";
import type { EgressMode } from "./network-policy.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("security");

export interface EgressPolicySnapshot {
  mode: EgressMode;
  allowlist: string[];
  configured: boolean;
}

/**
 * A host as the allowlist stores it: lowercase, no scheme, path or port, either
 * a registrable name (`api.github.com`) or a wildcard on one (`*.github.com`).
 * Anything else is refused rather than guessed at.
 */
export function normalizeEgressHost(raw: string): string | null {
  let s = String(raw ?? "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  const wildcard = s.startsWith("*.");
  const name = wildcard ? s.slice(2) : s;
  if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(name)) return null;
  // A numeric last label is an IP literal, not a name; addresses follow the
  // SSRF rules, never the allowlist.
  if (/^\d+$/.test(name.slice(name.lastIndexOf(".") + 1))) return null;
  return wildcard ? `*.${name}` : name;
}

/** Patch ~/.lax/security.json in place, keeping every other key. */
export function updateSecurityJson(patch: Record<string, unknown>): void {
  const cfgPath = join(getLaxDir(), "security.json");
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try { cfg = JSON.parse(readFileSync(cfgPath, "utf-8")); } catch { cfg = {}; }
  }
  atomicWriteFileSync(cfgPath, JSON.stringify({ ...cfg, ...patch }, null, 2) + "\n");
}

export class EgressPolicyState {
  mode: EgressMode;
  allowlist: Set<string>;
  configured: boolean;

  constructor() {
    this.mode = loadEgressMode();
    const loaded = loadEgressAllowlist(this.mode);
    this.allowlist = loaded.allowlist;
    this.configured = loaded.configured;
  }

  snapshot(): EgressPolicySnapshot {
    return { mode: this.mode, allowlist: [...this.allowlist].sort(), configured: this.configured };
  }

  setMode(mode: EgressMode): EgressPolicySnapshot {
    this.mode = mode;
    updateSecurityJson({ egressMode: mode });
    logger.info(`[security] Web access mode changed to: ${mode}`);
    return this.snapshot();
  }

  /** Replace the allowlist. An empty list in strict mode denies every host, on purpose. */
  setAllowlist(hosts: readonly string[]): EgressPolicySnapshot {
    const normalized = new Set<string>();
    for (const h of hosts) {
      const n = normalizeEgressHost(h);
      if (n === null) throw new Error(`"${h}" is not a host name (use example.com or *.example.com)`);
      normalized.add(n);
    }
    this.allowlist = normalized;
    this.configured = true;
    atomicWriteFileSync(join(getLaxDir(), "egress-allowlist.json"), JSON.stringify([...normalized].sort(), null, 2) + "\n");
    logger.info(`[security] Web access allowlist changed: ${normalized.size} hosts`);
    return this.snapshot();
  }

  allow(host: string): EgressPolicySnapshot {
    const n = normalizeEgressHost(host);
    if (n === null) throw new Error(`"${host}" is not a host name (use example.com or *.example.com)`);
    return this.setAllowlist([...this.allowlist, n]);
  }

  remove(host: string): EgressPolicySnapshot {
    const n = normalizeEgressHost(host) ?? host;
    return this.setAllowlist([...this.allowlist].filter((h) => h !== n));
  }
}
