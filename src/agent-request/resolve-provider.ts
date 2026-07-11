import { MIN_MAX_ITERATIONS, type LAXConfig } from "../types.js";
import type { SecretsStore } from "../secrets.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS, isHttpProvider } from "../providers/registry.js";
import { rerouteToCredentialedProvider } from "../providers/credential-reroute.js";
import { loadSettings, getSetting } from "../settings.js";
import { normalizeReasoningEffort, type ReasoningEffort } from "../providers/reasoning-effort.js";
import { resolveCredential } from "../auth/resolve.js";
import type { CredentialSource } from "../auth/auth-provider.js";
import { createLogger } from "../logger.js";
import { isLocalOnlyMode, localProviderDecision } from "../local-only-policy.js";

const logger = createLogger("agent-request.resolve-provider");

const isProviderId = (s: string): s is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(s);

/** Emitted when a forced credential fallback abandoned the provider the
 *  caller/settings actually asked for — a silent downgrade (e.g. a momentary
 *  `hasCredential()` miss reroutes a Fable-5 chat onto Grok's default model).
 *  Surfaced on the resolve result so the caller can signal the user rather
 *  than continue the turn on the wrong model with no indication. */
export interface ProviderSwitch {
  from: ProviderId;
  to: ProviderId;
  reason: "credential-unavailable" | "local-only";
}

export async function resolveProvider(
  config: LAXConfig,
  secretsStore: SecretsStore,
  dataDir: string,
  /** Optional override — forces this provider id if creds are available;
   *  falls through to the normal auto-detect chain otherwise. */
  providerOverride?: string,
  /** Optional model override. Takes precedence over `saved.model` and the
   *  provider registry default. Only honored when non-empty. */
  modelOverride?: string,
): Promise<{
  provider: string;
  apiKey: string;
  model: string;
  codexApiKey?: string;
  customBaseURL?: string;
  temperature: number;
  maxIterations: number;
  /** User-selected thinking depth for reasoning models (settings.reasoningEffort). */
  reasoningEffort: ReasoningEffort;
  /** How the active provider's credential was sourced — `oauth` means a
   *  flat-rate subscription (Claude CLI / SuperGrok / ChatGPT) where per-call
   *  USD is fiction; the rest are real per-token API keys. Drives whether the
   *  USD spend cap applies (see cost-tracker `isBillableSource`). */
  authSource?: CredentialSource;
  /** Set only when a forced credential fallback dropped the requested
   *  provider (see {@link ProviderSwitch}). Undefined on the happy path. */
  providerSwitch?: ProviderSwitch;
}> {
  // Load saved settings (spread because the codepath blanks saved.model below)
  const saved: Record<string, unknown> = { ...loadSettings() };

  // Resolve provider. If a saved provider exists but has no usable credentials,
  // fall through to auto-detection so a stale "codex" default from a previous
  // run doesn't block a freshly-signed-in Anthropic user. Each provider's
  // auth adapter owns the per-provider presence check.
  const hasCredsFor = (p: ProviderId): boolean =>
    PROVIDERS[p].auth.hasCredential({ secretsStore, configOpenAIKey: config.openaiApiKey });
  // Caller-supplied override takes precedence if creds are available.
  // Lets a worker honor op.contextPack.routing.preferredProvider without
  // having to mutate settings.json.
  let provider: ProviderId | "" = "";
  let providerWasOverridden = false;
  const savedProvider = String(saved.provider || "");
  // The provider the caller/settings actually asked for — a valid override
  // wins, else the saved provider. Empty on a fresh install with no
  // preference. Used below to tell an UNREQUESTED forced fallback (a silent
  // downgrade worth surfacing) from a legitimate fresh-install default.
  const requestedProvider: ProviderId | "" =
    (providerOverride && isProviderId(providerOverride)) ? providerOverride
      : isProviderId(savedProvider) ? savedProvider
        : "";
  if (isLocalOnlyMode(config)) {
    const customBaseUrl = getSetting<string>("customBaseUrl") || undefined;
    const requestedAllowed = requestedProvider
      ? localProviderDecision(requestedProvider, config, customBaseUrl).allowed
      : false;
    provider = requestedAllowed ? requestedProvider : "local";
    if (!localProviderDecision(provider, config, customBaseUrl).allowed) {
      throw new Error("Strict local-only mode requires Ollama on a loopback URL or a loopback custom provider.");
    }
    if (provider !== requestedProvider) {
      providerWasOverridden = true;
      saved.model = "";
    }
  }
  if (!isLocalOnlyMode(config) && providerOverride && isProviderId(providerOverride) && hasCredsFor(providerOverride)) {
    provider = providerOverride;
    // If the caller-supplied override differs from the saved provider, the
    // saved model belongs to the old provider (e.g. settings.json says
    // codex/gpt-5.5, override forces anthropic, but saved model is still
    // gpt-5.5 — Claude has no idea what that is). Blank it so the
    // downstream default picker chooses a valid model for the new provider.
    if (providerOverride !== savedProvider) providerWasOverridden = true;
  } else if (!isLocalOnlyMode(config) && isProviderId(savedProvider)) {
    provider = savedProvider;
  }
  // Distinct from `providerWasOverridden` (an INTENTIONAL caller switch whose
  // modelOverride is meant for the new provider): a forced fallback means the
  // requested provider could not be honored at all. The fallback chain itself
  // is shared with the classifier context seam — see credential-reroute.ts.
  const reroute = isLocalOnlyMode(config)
    ? { provider: provider as ProviderId, rerouted: false }
    : rerouteToCredentialedProvider(provider, hasCredsFor, { allowCodexFallback: !config.openaiApiKey });
  const forcedFallback = reroute.rerouted;
  if (forcedFallback) providerWasOverridden = true;
  provider = reroute.provider;
  // If we fell through to a different provider OR the caller-override forced
  // a switch, the saved model almost certainly belongs to the old provider.
  // Blank it so the downstream default picker picks something valid.
  if (providerWasOverridden) saved.model = "";

  // A forced fallback that abandoned a provider the caller/settings actually
  // asked for is a SILENT DOWNGRADE: a momentary `hasCredential()` miss can
  // reroute e.g. a Fable-5 chat onto Grok's default model with no signal, and
  // any modelOverride chosen for the old provider would otherwise be run
  // verbatim on the new one. Surface a switch event, warn to the log, and drop
  // the now-orphaned modelOverride so the new provider's default picker runs.
  let providerSwitch: ProviderSwitch | undefined;
  let effectiveModelOverride = modelOverride;
  if (forcedFallback && requestedProvider && requestedProvider !== provider) {
    providerSwitch = { from: requestedProvider, to: provider, reason: "credential-unavailable" };
    effectiveModelOverride = undefined;
    logger.warn(
      `provider switch: '${requestedProvider}' unavailable (no usable credential) — ` +
      `rerouted to '${provider}'. Dropping model override; using ${provider} default.`,
    );
  }
  if (isLocalOnlyMode(config) && requestedProvider && requestedProvider !== provider) {
    providerSwitch = { from: requestedProvider, to: provider, reason: "local-only" };
    effectiveModelOverride = undefined;
  }

  // Resolve API key
  let apiKey: string;
  let codexApiKey: string | undefined;
  let customBaseURL: string | undefined;

  const meta = PROVIDERS[provider];
  const r = await resolveCredential(provider, { configOpenAIKey: config.openaiApiKey });
  apiKey = r?.credential ?? "";
  const authSource = r?.source;

  if (!isHttpProvider(meta)) {
    // Anthropic (CLI transport) also carries a Codex side-key so build_app
    // can route through the Codex CLI even when the main provider is Claude.
    const cr = await resolveCredential("codex", { configOpenAIKey: config.openaiApiKey });
    codexApiKey = cr?.credential || undefined;
    if (!codexApiKey) codexApiKey = secretsStore.get("OPENAI_API_KEY") || undefined;
  } else if (provider === "custom") {
    customBaseURL = getSetting<string>("customBaseUrl") || undefined;
  }

  // Default model — registry is SoT. Falls back to config.model when
  // the registry leaves defaultModel empty (e.g., ollama-cloud where
  // the user picks from the cloud catalog). Caller-supplied modelOverride
  // wins when non-empty (per-job cron model selection).
  const model = (effectiveModelOverride && effectiveModelOverride.trim())
    || String(saved.model || "")
    || meta.defaultModel
    || config.model;

  if (isLocalOnlyMode(config) && provider === "local") {
    const { fetchLocalOllamaTags } = await import("../ollama-cloud.js");
    const local = await fetchLocalOllamaTags(config.ollamaUrl);
    const normalize = (name: string) => name.replace(/:latest$/, "");
    if (!local.reachable) throw new Error("Strict local-only mode could not reach the configured loopback Ollama endpoint.");
    if (!local.models.some((entry) => normalize(entry.name) === normalize(model))) {
      throw new Error(`Strict local-only mode requires model "${model}" to exist on the configured loopback Ollama endpoint.`);
    }
  }

  const temperature = typeof saved.temperature === "number" ? saved.temperature : config.temperature;
  const reasoningEffort = normalizeReasoningEffort(saved.reasoningEffort);
  // settings.json is read schema-less, so legacy saved caps (old UI default 25)
  // land here raw — clamp to the floor. config.maxIterations is already clamped
  // at load (config.ts), but Math.max both keeps this seam self-sufficient.
  const maxIterations = Math.max(
    MIN_MAX_ITERATIONS,
    typeof saved.maxIterations === "number" ? saved.maxIterations : config.maxIterations,
  );

  return { provider, apiKey, model, codexApiKey, customBaseURL, temperature, maxIterations, reasoningEffort, authSource, providerSwitch };
}
