import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { getLaxDir } from "../../lax-data-dir.js";
import { getLocalRuntimes } from "../../local-runtimes/cache.js";
import { manualAllowlist } from "../../local-runtimes/endpoints.js";
import type { FileAccessMode, InlineEvalPolicy } from "./types.js";
import type { EgressMode } from "./network-policy.js";

import { createLogger } from "../../logger.js";
const logger = createLogger("security.layer-core");

/**
 * Load the egress allowlist from ~/.lax/egress-allowlist.json.
 *
 * In permissive mode (default): the allowlist is the "trusted destinations"
 * list — hosts the agent may send secret-shaped payloads to. Hosts not listed
 * are still reachable for plain surfing; only secret-bearing POST/PUT/PATCH/
 * DELETE bodies are gated (enforced at the tool layer).
 *
 * In strict mode: the allowlist is the only set of hosts the agent may reach at
 * all. A missing file in strict mode → deny-with-hint.
 *
 * `configured` is true once a file loaded successfully (even content `[]`), so
 * evaluateWebFetch can distinguish "operator configured an empty allowlist
 * (deny everything)" from "no file present". A missing file previously fell open
 * to every public host — the feature failed-open on a default install.
 */
export function loadEgressAllowlist(egressMode: EgressMode): { allowlist: Set<string>; configured: boolean } {
  try {
    const allowlistPath = join(getLaxDir(), "egress-allowlist.json");
    if (existsSync(allowlistPath)) {
      const parsed = JSON.parse(readFileSync(allowlistPath, "utf-8"));
      if (Array.isArray(parsed)) {
        const allowlist = new Set(parsed.map((d: unknown) => String(d).toLowerCase()));
        logger.info(`[security] Egress allowlist loaded: ${allowlist.size} domains (mode=${egressMode})`);
        return { allowlist, configured: true };
      }
      logger.warn(`[security] ${allowlistPath} is not a JSON array — treating as missing`);
    } else if (egressMode === "strict") {
      logger.warn(
        `[security] strict mode but no allowlist at ${allowlistPath} — all outbound requests will be denied. ` +
        `Create the file with a JSON array of allowed domains or set egressMode to "permissive" in ~/.lax/security.json.`,
      );
    }
  } catch (e) {
    logger.warn(`[security] Failed to load egress allowlist: ${(e as Error).message}`);
  }
  return { allowlist: new Set(), configured: false };
}

export function loadEgressMode(): EgressMode {
  try {
    const cfgPath = join(getLaxDir(), "security.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.egressMode === "strict" || cfg.egressMode === "permissive") {
        return cfg.egressMode;
      }
    }
  } catch {}
  return "permissive";
}

/**
 * The loopback port of the configured ollama endpoint — IF, and only if, that
 * endpoint is a LITERAL loopback IP. Folded into the local-service-ports
 * allowlist so the agent can reach its own local model/embedding server
 * (default 127.0.0.1:11434) without the operator hand-listing the port.
 *
 * SECURITY (validate-as-loopback): ollamaUrl lives in config.json, which the
 * agent itself can write — so its HOST is never trusted. We only ever extract a
 * PORT, and only when the configured host is a literal loopback IP (127.0.0.1
 * or ::1). A config poisoned to a hostname or a metadata/private IP yields null
 * and is ignored. The carve-out can therefore only ever permit a LOOPBACK port,
 * never a non-loopback host — the loopback host check in evaluateWebFetch still
 * gates every request. An explicit empty ollamaUrl disables the carve-out.
 */
/** Pure core of {@link ollamaLoopbackPort} — validate-as-loopback. Exposed for
 *  tests: it is the security boundary, so its config-injection immunity must be
 *  asserted directly. Returns a port string ONLY for a literal loopback host. */
export function ollamaPortFromUrl(ollamaUrl: string): string | null {
  if (ollamaUrl === "") return null; // operator disabled it
  try {
    const u = new URL(ollamaUrl);
    const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "::1") return null; // literal loopback only
    const port = u.port || "11434";
    const n = Number(port);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return String(n);
  } catch {}
  return null;
}

export function ollamaLoopbackPort(): string | null {
  let ollamaUrl = "http://127.0.0.1:11434";
  try {
    const cfgPath = join(getLaxDir(), "config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (typeof cfg.ollamaUrl === "string") ollamaUrl = cfg.ollamaUrl.trim();
    }
  } catch {}
  return ollamaPortFromUrl(ollamaUrl);
}

/** Pure: the port of a LITERAL-loopback URL (127.0.0.1/::1 — hostnames
 *  including "localhost" rejected, same DNS-rebind boundary as
 *  ollamaPortFromUrl), explicit ports only (no default-port guessing —
 *  that's how exact allowlists rot into prefixes). */
export function loopbackPortFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "::1") return null;
    const n = Number(u.port);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return String(n);
  } catch {}
  return null;
}

/**
 * Loopback ports of local inference runtimes the agent's HTTP tools may
 * reach: every DISCOVERED runtime's loopback port plus operator manual-add
 * entries from settings.json that are LOOPBACK.
 *
 * Discovered — not the sweep's candidate port list. The sweep list exists
 * to find runtimes and grows freely (Jan, GPT4All, KoboldCpp, dev-server
 * ports like 5000); agent egress is a separate authorization that only
 * live evidence grants: a port joins this set once something answering an
 * inference-runtime handshake was actually found there, and leaves when
 * the runtime stops (next sweep drops it). Before the first sweep lands
 * the set is manual-adds-only — the Ollama chat port keeps its own
 * config-based carve-out (ollamaLoopbackPort), so the primary runtime
 * never waits on discovery.
 *
 * Non-loopback runtimes never fold in HERE: the loopback-host guard in
 * network-policy makes bare-port entries meaningless for them. A named
 * LAN box gets agent egress through the SEPARATE exact host:port fold —
 * manualRuntimeHostPorts() below — never through this port set.
 * settings.json is read raw from disk, not via the settings cache, so a
 * security decision never runs on a stale allowlist.
 */
export function localRuntimeLoopbackPorts(): Set<string> {
  const ports = new Set<string>();
  for (const rt of getLocalRuntimes() ?? []) {
    const port = loopbackPortFromUrl(rt.endpoint.baseUrl);
    if (port) ports.add(port);
  }
  try {
    const sPath = join(getLaxDir(), "settings.json");
    if (existsSync(sPath)) {
      const s = JSON.parse(readFileSync(sPath, "utf-8"));
      if (Array.isArray(s?.localRuntimes)) {
        for (const e of s.localRuntimes) {
          const url = e && typeof e === "object" && typeof (e as { baseUrl?: unknown }).baseUrl === "string"
            ? (e as { baseUrl: string }).baseUrl
            : "";
          const port = loopbackPortFromUrl(url);
          if (port) ports.add(port);
        }
      }
    }
  } catch {}
  return ports;
}

/**
 * Exact "host:port" identities of operator manual-add runtime entries
 * (settings.localRuntimes) — the SAME validated set the admission gate
 * matches (endpoints.ts manualAllowlist), so chat routing and agent-tool
 * egress agree by construction, never via a second parallel allowlist.
 * Non-loopback entries are the point: a hand-named LAN GPU box clears the
 * private-range egress block in network-policy for the agent's own HTTP
 * tools. Loopback-only invariants are untouched — the discovery sweep and
 * the port carve-out above stay loopback-only; this set only ever admits
 * a host:port the operator typed. Read raw from disk (not the settings
 * cache) and re-derived per decision, so an operator add/remove takes
 * effect immediately and never runs on a stale allowlist.
 *
 * SECURITY / keep-in-sync: entries here GRANT agent egress to their exact
 * host:port. The endpoint that writes them, POST/DELETE /api/local-runtimes,
 * is therefore agent-role-DENIED (rbac.ts ROLE_PERMISSIONS.agent.deniedEndpoints)
 * for exactly that reason — otherwise a self-calling injected agent could name
 * its own egress targets (confused-deputy escalation). This derivation trusts
 * that only the operator populates settings.localRuntimes. If you ever open the
 * route to the agent role, this carve-out becomes an agent-controlled allowlist —
 * update both sites together.
 */
export function manualRuntimeHostPorts(): Set<string> {
  try {
    const sPath = join(getLaxDir(), "settings.json");
    if (existsSync(sPath)) {
      const s: unknown = JSON.parse(readFileSync(sPath, "utf-8"));
      if (s && typeof s === "object") {
        return new Set(manualAllowlist(s as Record<string, unknown>));
      }
    }
  } catch {}
  return new Set();
}

export function loadLocalServicePorts(): Set<string> {
  const ports = new Set<string>();
  try {
    const cfgPath = join(getLaxDir(), "security.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (Array.isArray(cfg.localServicePorts)) {
        for (const p of cfg.localServicePorts) {
          const n = Number(p);
          if (Number.isInteger(n) && n > 0 && n <= 65535) ports.add(String(n));
        }
      }
    }
  } catch {}
  const ollama = ollamaLoopbackPort();
  if (ollama) ports.add(ollama);
  for (const p of localRuntimeLoopbackPorts()) ports.add(p);
  if (ports.size > 0) {
    logger.info(`[security] Local service ports loaded: ${ports.size} ports`);
  }
  return ports;
}

// Opt-in financial-data egress guard. OFF by default so it never regresses the
// utility of normal sends; security-conscious deployments enable it to block
// financial-account data (IBAN / card numbers) leaving to non-allowlisted hosts.
// Honors the LAX_DATA_EGRESS_GUARD=1 env override for ops/testing.
export function loadDataEgressGuard(): boolean {
  if (process.env.LAX_DATA_EGRESS_GUARD === "1") return true;
  try {
    const cfgPath = join(getLaxDir(), "security.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      return cfg.dataEgressGuard === true;
    }
  } catch {}
  return false;
}

export function loadFileAccessMode(): FileAccessMode {
  try {
    const cfgPath = join(getLaxDir(), "security.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (["workspace", "common", "unrestricted"].includes(cfg.fileAccessMode)) {
        return cfg.fileAccessMode;
      }
    }
  } catch {}
  // Default for fresh installs: ships full read access so out-of-box flows
  // (memory ingest, reading exports in Downloads/Documents) work without the
  // user first changing a setting. Tighten to common/workspace in Settings.
  return "unrestricted";
}

const MODE_RANK: Record<FileAccessMode, number> = { workspace: 0, common: 1, unrestricted: 2 };

// The user's configured file-access mode, but never BELOW `floor`. The subsystem
// agents (cron, build-app, autopilot round, self-edit surgeon) use this instead
// of a hardcoded literal so they HONOR a broader user setting — the "one
// canonical switch" principle: if the user sets unrestricted, a scheduled or
// autopilot delete of ~/Downloads works too — while never dropping below the
// minimum a subsystem needs to function (build-app must read user assets →
// "common" floor; cron floors at "workspace"). Writes stay confined by each
// caller's addAllowedPath(worktree/appDir) regardless of the mode, so widening
// the mode only widens READ/DELETE reach, never where the agent may write.
export function loadFileAccessModeAtLeast(floor: FileAccessMode): FileAccessMode {
  const mode = loadFileAccessMode();
  return MODE_RANK[mode] >= MODE_RANK[floor] ? mode : floor;
}

// Inline-eval interpreter-escape policy (R4-11/R4-13). Loaded SEPARATELY from
// loadFileAccessMode on purpose: the inline-interpreter escape hatch (a regex
// can't soundly vet a Turing-complete `python -c` body) must stay closed
// regardless of how broad file access is. Decoupling means a permissive file
// default can never silently re-open it. Opt in with "allow" via security.json.
export function loadInlineEvalPolicy(): InlineEvalPolicy {
  try {
    const cfgPath = join(getLaxDir(), "security.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.inlineEvalPolicy === "refuse" || cfg.inlineEvalPolicy === "allow") {
        return cfg.inlineEvalPolicy;
      }
    }
  } catch {}
  return "refuse";
}
