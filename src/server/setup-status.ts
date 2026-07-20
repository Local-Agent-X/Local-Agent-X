// Setup status — what the install couldn't finish, and what's still degraded now.
//
// Two independent sources answer "is this machine fully set up?", and neither
// reached the user before this module existed:
//
//  1. ~/.lax/install-report.json — written by scripts/install-common.mjs for
//     every OPTIONAL step that degraded (Ollama unreachable via winget, Python
//     skipped, …). Install-time truth, but the installer window is long closed
//     by the time it matters.
//  2. The live embedding provider — bootstrap-services runs a retry ladder
//     (10s…60s) that self-heals a late Ollama. Runtime truth, previously only
//     ever logged.
//
// Install-time truth ALONE is a trap: a user who hits the degraded path and
// then installs Ollama by hand still has "ollama" in install-report.json
// forever. So the live probe is authoritative and the report is only a reason —
// it explains WHY something is missing, it never decides THAT it's missing.
// (Same rule shouldNotShowOnboarding learned the hard way on 2026-05-17:
// "registered" is not "working", and a stale cached flag that outlives the
// condition it described actively misleads.)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_EMBEDDING_PROVIDER } from "../embedding-providers/types.js";

export interface DegradedComponent {
  /** Install step id from ALL_STEPS (e.g. "ollama"), or a runtime component id. */
  id: string;
  /** Human label for the UI. */
  label: string;
  /** What the user loses while this is missing. */
  impact: string;
  /** Why it's missing — installer message when we have one, else a live probe result. */
  reason: string;
  /** Repair the app can perform itself, or null when it needs the user. */
  action: "reinit-embeddings" | null;
  /** Manual escape hatch, shown when action is null or repair fails. */
  manual: string;
}

interface InstallReport {
  installedAt?: string;
  selections?: { ollamaRuntime: boolean; ollamaMemoryModel: boolean };
  degraded?: Array<{ step?: string; message?: string }>;
}

/** Read the installer's record of optional steps that degraded. Absent file =
 *  no report (an older install, or a dev clone) — NOT "nothing degraded". */
export function readInstallReport(dataDir?: string): InstallReport | null {
  const path = join(dataDir || join(homedir(), ".lax"), "install-report.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as InstallReport;
    return Array.isArray(parsed?.degraded) ? parsed : null;
  } catch {
    return null; // corrupt report is the same as no report — never a signal
  }
}

/** The installer's message for a step, when it recorded one. */
function installerReasonFor(stepId: string, report: InstallReport | null): string | null {
  const hit = report?.degraded?.find((d) => d?.step === stepId);
  return hit?.message ? String(hit.message) : null;
}

/**
 * Build the live list of degraded optional components.
 *
 * `embeddingsDegraded` MUST come from a real probe of the running provider —
 * pass null when the probe itself failed or hasn't run. A failed probe is
 * explicitly NOT treated as degraded: a transient blip must never manufacture a
 * permanent "something's broken" prompt (the false-signal bug that got the old
 * Getting Started checklist deleted). Unknown means stay quiet.
 */
export function buildDegradedList(
  embeddingsDegraded: boolean | null,
  report: InstallReport | null,
): DegradedComponent[] {
  const out: DegradedComponent[] = [];
  if (embeddingsDegraded === true) {
    out.push({
      id: "ollama",
      label: "Semantic memory",
      impact: "Memory search falls back to keyword matching.",
      // Prefer the installer's account (it knows winget failed and why) and
      // fall back to the live symptom when this install predates the report.
      reason:
        installerReasonFor("ollama", report) ||
        "The Ollama embedding model isn't reachable.",
      action: "reinit-embeddings",
      manual: "Install Ollama from https://ollama.com/download, then click Reconnect.",
    });
  }
  return out;
}

/** True when the app has everything it needs. */
export function isFullySetUp(components: DegradedComponent[]): boolean {
  return components.length === 0;
}

/**
 * Is semantic memory degraded right now? true / false / null (can't tell).
 *
 * Deliberately does NOT infer from the embedding singleton. When Ollama is
 * unreachable, bootstrap-services returns early WITHOUT setting the singleton
 * (it refuses to wire a provider that can't serve) — so an absent singleton is
 * ambiguous: it means either "user chose no embeddings" or "the exact fault we
 * need to report". Reading it inverted the answer, reporting ready:true on a
 * machine with no Ollama at all (caught driving the live route, not by unit
 * tests, which had mocked this seam away).
 *
 * Instead ask the source of truth directly: the configured provider's own
 * reachability, using the same tags probe bootstrap uses. Settings are read
 * fresh — the user can change provider without a restart.
 */
export async function probeEmbeddingsDegraded(): Promise<boolean | null> {
  try {
    const { loadSettings } = await import("../settings.js");
    const settings = loadSettings() as Record<string, unknown>;
    const provider = String(settings.embeddingProvider || DEFAULT_EMBEDDING_PROVIDER);
    // Anything that isn't a local Ollama can't be probed from here, and its
    // failures are per-request rather than a service being down. Unknown.
    if (provider !== "ollama") return null;

    const { fetchLocalOllamaTags } = await import("../ollama-cloud.js");
    const ollamaUrl = String(settings.ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
    const { reachable, models } = await fetchLocalOllamaTags(ollamaUrl);
    if (!reachable) return true; // Ollama itself is down — the fault we exist to report

    // Reachable but the embedding model never landed is equally degraded:
    // embeds would return empty vectors and memory silently drops to keyword.
    const { embeddingModelInstalled } = await import("./embedding-model-match.js");
    const target = String(settings.embeddingModel || "mxbai-embed-large");
    return !embeddingModelInstalled(target, models.map((m) => m.name));
  } catch {
    return null; // couldn't determine — stay quiet rather than cry wolf
  }
}
