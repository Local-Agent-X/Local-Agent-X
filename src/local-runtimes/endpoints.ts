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
  // Known openai-compat loopback ports probes don't claim yet get swept
  // once the openai-compat probe lands (its defaultPorts cover them).

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
