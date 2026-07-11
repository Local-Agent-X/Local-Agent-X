import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { getLaxDir } from "../../lax-data-dir.js";
import type { FileAccessMode, InlineEvalPolicy } from "./types.js";
import type { EgressMode } from "./network-policy.js";

import { createLogger } from "../../logger.js";
const logger = createLogger("security.layer-core");

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
