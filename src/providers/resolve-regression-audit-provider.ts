/**
 * Resolves the OPTIONAL cross-provider audit target for the regression-audit
 * completion gate (settings: regressionAuditProvider / regressionAuditModel).
 *
 * Deliberately NOT part of resolve-provider-context.ts: that module's
 * contract is "classifiers run on the provider chat effectively runs on,
 * never a cross-provider fan-out" (classify-with-llm.ts's dark-mode-freeze
 * history is why) — a real invariant every OTHER classifier still relies on.
 * This resolver is the one explicit, opt-in exception: a SECOND provider the
 * user has deliberately configured, used only by the regression-audit gate,
 * and only when it actually has a usable credential.
 *
 * Returns null in every other case (unset, unknown id, same as chat's active
 * provider, no credential) — the gate must degrade to its same-model
 * fresh-context default, never block or fail a build over an audit-provider
 * misconfiguration.
 */
import { loadSettings } from "../settings.js";
import { resolveCredential } from "../auth/resolve.js";
import { PROVIDER_IDS, type ProviderId } from "./provider-ids.js";
import { PROVIDERS } from "./registry.js";
import { createLogger } from "../logger.js";

const logger = createLogger("providers.resolve-regression-audit-provider");

const isProviderId = (s: string): s is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(s);

export interface RegressionAuditProviderOverride {
  provider: string;
  apiKey: string;
  model: string;
}

export async function resolveRegressionAuditProvider(): Promise<RegressionAuditProviderOverride | null> {
  const s = loadSettings() as {
    regressionAuditProvider?: string;
    regressionAuditModel?: string;
    provider?: string;
  };
  const requested = String(s.regressionAuditProvider || "").toLowerCase().trim();
  if (!requested) return null; // feature unset — same-model default

  // "ollama" (bare) is a legitimate settings.provider value handled as a
  // special case throughout this codebase (resolve-provider-context.ts,
  // classify-with-llm.ts) even though it isn't in the ProviderId union — only
  // "ollama-cloud" is a registry entry. Mirror that special case here rather
  // than rejecting it, but keep it out of the ProviderId-typed path below.
  if (requested !== "ollama" && !isProviderId(requested)) {
    logger.warn(`regressionAuditProvider "${requested}" is not a known provider id — falling back to same-model audit`);
    return null;
  }
  if (requested === String(s.provider || "").toLowerCase().trim()) {
    // Configured to the same provider chat is already on — zero decorrelation
    // benefit over the cheaper same-model path, and worth calling out because
    // it's a likely no-op misconfiguration rather than a deliberate choice.
    logger.info(`regressionAuditProvider "${requested}" matches the active chat provider — same-model audit covers this already`);
    return null;
  }

  const configuredModel = String(s.regressionAuditModel || "").trim();

  if (requested === "ollama" || requested === "local") {
    // No real credential needed — mirrors resolve-provider-context.ts. "local"
    // still has a registry defaultModel; bare "ollama" does not, so it needs
    // an explicit model configured.
    if (requested === "local") {
      return { provider: requested, apiKey: "ollama", model: configuredModel || PROVIDERS.local.defaultModel };
    }
    if (!configuredModel) {
      logger.info(`regressionAuditProvider "ollama" needs regressionAuditModel set explicitly — falling back to same-model audit`);
      return null;
    }
    return { provider: requested, apiKey: "ollama", model: configuredModel };
  }

  // Narrows `requested` to ProviderId for TS — always true here (the ollama
  // branch above already returned, and the entry guard rejected anything that
  // is neither "ollama" nor a real ProviderId).
  if (!isProviderId(requested)) return null;

  let apiKey = "";
  try {
    const r = await resolveCredential(requested);
    apiKey = r?.credential || "";
  } catch {
    /* fall through to the no-credential warning below */
  }
  if (!apiKey) {
    logger.info(`regressionAuditProvider "${requested}" configured but has no usable credential — falling back to same-model audit`);
    return null;
  }

  const model = configuredModel || PROVIDERS[requested].defaultModel;
  return { provider: requested, apiKey, model };
}
