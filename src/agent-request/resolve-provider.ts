import { MIN_MAX_ITERATIONS, type LAXConfig } from "../types.js";
import type { SecretsStore } from "../secrets.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import { PROVIDERS, isHttpProvider } from "../providers/registry.js";
import { rerouteToCredentialedProvider } from "../providers/credential-reroute.js";
import { loadSettings, getSetting } from "../settings.js";
import { normalizeReasoningEffort, type ReasoningEffort } from "../providers/reasoning-effort.js";
import { resolveCredential } from "../auth/resolve.js";
import type { CredentialResolution, CredentialSource } from "../auth/auth-provider.js";
import { createLogger } from "../logger.js";
import { isLocalOnlyMode, localProviderDecision } from "../local-only-policy.js";

const logger = createLogger("agent-request.resolve-provider");

const isProviderId = (s: string): s is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(s);

/** Emitted when a forced credential fallback abandoned the provider the
 *  caller/settings actually asked for — a silent downgrade (e.g. a dead xAI
 *  sign-in reroutes a Grok chat onto Claude's default model). Surfaced on the
 *  resolve result so the caller can signal the user rather than continue the
 *  turn on the wrong model with no indication.
 *
 *  `credential-unavailable` is a claim about the CREDENTIAL, not about the
 *  cheap `hasCredential()` probe: it is raised only after resolveCredential
 *  itself came back empty for the requested provider, so a caller may safely
 *  treat it as "this provider genuinely cannot run the turn" and fail rather
 *  than reroute. Anything the probe merely failed to SEE (env-only keys — see
 *  auth-provider.ts) is honored instead of reported here. */
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

  // The chain above runs entirely on `hasCredential()` — the cheap SYNC probe,
  // which is DELIBERATELY narrower than the async `resolve()` that actually
  // runs the turn. auth-provider.ts says it verbatim: "`resolve()` falls back
  // to process.env; `hasCredential()` never does", and anthropic's probe never
  // reads the secrets store at all. So a provider configured by env var alone —
  // the headless/CI shape — reads UNAVAILABLE here and AVAILABLE thirty lines
  // below, and the chain abandons a provider that works. That is not a
  // "momentary" miss; for those installs it is permanent and by design, which
  // makes the switch we'd report a lie, and callers that act on it (the
  // interactive chat path FAILS the turn on it) punish a healthy configuration.
  // So don't take the probe's word: ask the authority whether the provider that
  // was actually REQUESTED can produce a credential. If it can, the request is
  // honorable and the reroute was an artifact of the probe's blind spots.
  // Bounded on purpose — this only runs when we were about to leave the
  // requested provider, so the happy path pays nothing, and the resolution is
  // reused as the turn's credential below rather than resolved twice.
  let rescued: { provider: ProviderId; credential: CredentialResolution } | null = null;
  if (!isLocalOnlyMode(config) && requestedProvider && reroute.provider !== requestedProvider) {
    const found = await resolveCredential(requestedProvider, { configOpenAIKey: config.openaiApiKey });
    if (found?.credential) rescued = { provider: requestedProvider, credential: found };
  }
  const forcedFallback = reroute.rerouted && !rescued;
  if (forcedFallback) providerWasOverridden = true;
  // A rescue that lands on something other than the saved provider is an
  // honored caller override arriving late (the override branch above skipped it
  // because the probe couldn't see its credential) — same reasoning as there:
  // `saved.model` belongs to the provider we just left and can't run here.
  if (rescued && rescued.provider !== savedProvider) providerWasOverridden = true;
  provider = rescued ? rescued.provider : reroute.provider;
  // If we fell through to a different provider OR the caller-override forced
  // a switch, the saved model almost certainly belongs to the old provider.
  // Blank it so the downstream default picker picks something valid.
  if (providerWasOverridden) saved.model = "";

  // A forced fallback that abandoned a provider the caller/settings actually
  // asked for is a SILENT DOWNGRADE: it reroutes e.g. a Fable-5 chat onto
  // Grok's default model with no signal, and any modelOverride chosen for the
  // old provider would otherwise be run verbatim on the new one. Surface a
  // switch event, warn to the log, and drop the now-orphaned modelOverride so
  // the new provider's default picker runs. Because of the rescue above, this
  // fires only when the requested provider's credential could not be resolved
  // AT ALL — it is a genuine outage for that provider, not a probe artifact,
  // which is what makes it safe for the chat path to fail the turn on.
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
  // Reuse the rescue's resolution — it is for this exact provider, resolved
  // with these exact opts moments ago; resolving again would just repeat the
  // work (and, for anthropic/codex, a token refresh).
  const r = rescued?.credential ?? await resolveCredential(provider, { configOpenAIKey: config.openaiApiKey });
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
