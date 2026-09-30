// The operator's web-access policy as the security layer holds it: the mode
// (strict = only allowlisted hosts; permissive = any public host, the
// SSRF/denylist rules still apply) and the allowlist.
//
// The files are the truth, not this object. Every other reader (the browser
// worker, the shell egress proxy, loadEgressConfig) reads ~/.lax directly, so
// this state re-reads whenever the files change, keyed on their stat the way
// the browser worker keys its cache. A file the installer, a settings write
// on another tab, or a human edits while the server runs is seen by the next
// decision here, and the Settings page can never show a mode the block does
// not enforce. The setters write the files and then read them back.

import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
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

function statKey(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
}

interface Loaded { mode: EgressMode; allowlist: Set<string>; configured: boolean }

export class EgressPolicyState {
  private key = "";
  private state: Loaded = { mode: "permissive", allowlist: new Set(), configured: false };

  get mode(): EgressMode { return this.sync().mode; }
  get allowlist(): ReadonlySet<string> { return this.sync().allowlist; }
  get configured(): boolean { return this.sync().configured; }

  /** Reload from disk when either file changed since the last read. */
  private sync(): Loaded {
    const dir = getLaxDir();
    const key = `${statKey(join(dir, "security.json"))}|${statKey(join(dir, "egress-allowlist.json"))}`;
    if (key !== this.key) {
      const mode = loadEgressMode();
      const loaded = loadEgressAllowlist(mode);
      this.state = { mode, allowlist: loaded.allowlist, configured: loaded.configured };
      this.key = key;
    }
    return this.state;
  }

  snapshot(): EgressPolicySnapshot {
    const s = this.sync();
    return { mode: s.mode, allowlist: [...s.allowlist].sort(), configured: s.configured };
  }

  setMode(mode: EgressMode): EgressPolicySnapshot {
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
