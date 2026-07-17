/**
 * Endpoint resolution for local-runtime discovery.
 *
 * The endpoint set = the known-port loopback sweep (one candidate per
 * probe defaultPort) + config.ollamaUrl back-compat + operator-added
 * entries from settings.localRuntimes. Everything passes the admission
 * gate; auto-discovered endpoints are never persisted (re-swept each
 * refresh, so a stopped runtime disappears instead of going stale).
 *
 * settings.localRuntimes is the untyped settings.json bag, so entries
 * are validated structurally here on every read — a malformed entry is
 * skipped, never thrown on.
 */
import { getRuntimeConfig } from "../config.js";
import { loadSettings } from "../settings.js";
import { admitEndpoint, endpointHostPort } from "./admission.js";
import { LOCAL_RUNTIME_PROBES } from "./probes.js";
import type { LocalRuntimeEndpoint, LocalRuntimeKind } from "./types.js";

/** Shape of one settings.localRuntimes entry (operator manual-add). */
export interface ManualRuntimeEntry {
  kind: LocalRuntimeKind;
  baseUrl: string;
  label?: string;
}

export interface CandidateEndpoint {
  endpoint: LocalRuntimeEndpoint;
  /** Restrict detection to this kind (manual adds name their runtime). */
  kind: LocalRuntimeKind | null;
  label?: string;
}

const KINDS: ReadonlySet<string> = new Set(["ollama", "openai-compat"]);

/** Validated manual entries from settings.localRuntimes. Never throws. */
export function manualRuntimeEntries(
  settings: Record<string, unknown> = loadSettings(),
): ManualRuntimeEntry[] {
  const raw = settings.localRuntimes;
  if (!Array.isArray(raw)) return [];
  const out: ManualRuntimeEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as { kind?: unknown; baseUrl?: unknown; label?: unknown };
    if (typeof e.kind !== "string" || !KINDS.has(e.kind)) continue;
    if (typeof e.baseUrl !== "string" || endpointHostPort(e.baseUrl) === null) continue;
    out.push({
      kind: e.kind as LocalRuntimeKind,
      baseUrl: e.baseUrl.replace(/\/+$/, ""),
      label: typeof e.label === "string" && e.label.length > 0 ? e.label : undefined,
    });
  }
  return out;
}

/** The manual host:port allowlist the admission gate matches against. */
export function manualAllowlist(
  settings: Record<string, unknown> = loadSettings(),
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const e of manualRuntimeEntries(settings)) {
    const hp = endpointHostPort(e.baseUrl);
    if (hp) set.add(hp);
  }
  return set;
}

/**
 * Full candidate set for a discovery sweep: known loopback ports, the
 * configured ollamaUrl (back-compat — may be non-default), and manual
 * entries. Deduped by host:port; manual entries win the dedupe so their
 * kind restriction and label survive. Only admitted endpoints return.
 */
export function candidateEndpoints(
  settings: Record<string, unknown> = loadSettings(),
): CandidateEndpoint[] {
  const allow = manualAllowlist(settings);
  const byHostPort = new Map<string, CandidateEndpoint>();

  const add = (c: CandidateEndpoint) => {
    const hp = endpointHostPort(c.endpoint.baseUrl);
    if (!hp) return;
    if (!admitEndpoint(c.endpoint.baseUrl, allow).allowed) return;
    const existing = byHostPort.get(hp);
    if (existing && existing.endpoint.origin === "manual") return;
    byHostPort.set(hp, c);
  };

  for (const probe of LOCAL_RUNTIME_PROBES) {
    for (const port of probe.defaultPorts) {
      add({
        endpoint: { baseUrl: `http://127.0.0.1:${port}`, origin: "auto" },
        kind: null,
      });
    }
  }

  // Docker Model Runner is the one runtime whose OpenAI surface lives under
  // a PATH prefix (http://127.0.0.1:12434/engines/v1/...), so its candidate
  // carries the prefix in baseUrl — detect, listModels, and the `${baseUrl}/v1`
  // chat derivation then work unchanged. kind is pinned so the ollama probe
  // never wastes a detect on it.
  add({
    endpoint: { baseUrl: "http://127.0.0.1:12434/engines", origin: "auto" },
    kind: "openai-compat",
  });

  // Lemonade (documented default port 13305) also serves an OLLAMA-compatible
  // surface, so a null-kind candidate would be claimed by the ollama probe
  // (probe order: ollama detects first) and labeled "Ollama". Pin the kind —
  // same rationale as Docker Model Runner above. This add() overwrites the
  // null-kind 13305 the sweep loop just emitted (auto entries never survive a
  // later add). A genuinely-Ollama server a user runs on 13305 stays
  // reachable: manual entries (kind:"ollama") are added last and win the
  // dedupe over this auto pin.
  add({
    endpoint: { baseUrl: "http://127.0.0.1:13305", origin: "auto" },
    kind: "openai-compat",
  });

  const ollamaUrl = getRuntimeConfig().ollamaUrl.replace(/\/+$/, "");
  add({ endpoint: { baseUrl: ollamaUrl, origin: "auto" }, kind: "ollama" });

  for (const e of manualRuntimeEntries(settings)) {
    add({
      endpoint: { baseUrl: e.baseUrl, origin: "manual" },
      kind: e.kind,
      label: e.label,
    });
  }
  return [...byHostPort.values()];
}
