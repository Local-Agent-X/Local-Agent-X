// ── Chat: which provider is selected, is it connected, what is it called ──
//
// Split out of chat-status-bar.js (400-LOC source-hygiene ceiling), and a real
// seam rather than an arbitrary cut: everything here answers "identity of the
// current provider" and is consumed by the model chip, the cascade menu and the
// providers-payload freshness check alike.
//
// Loaded BEFORE chat-status-bar.js in app.html. Order is not tight — these are
// only ever called from inside functions, long after every script has parsed —
// but keeping them adjacent makes the dependency obvious.
//
// External deps (classic-script globals): apiFetch (shared-api.js).

// Resolve the picker entry for the SELECTED provider — by id, never by
// position. The server sets `active: current.provider === id` and only lists a
// provider whose credential gate passed, so a selection with no credential is
// absent from the list entirely and NOTHING is active. The old
// `find(p => p.active) || providers[0]` fallback then grabbed whatever provider
// happened to sit first and rendered its name beside the selected provider's
// model — "OpenAI Codex ▸ grok-4.5", a pairing that exists nowhere. It read as
// a confident answer and hid the real fault: the selected provider has no
// credential, so every turn against it fails.
//
// Returns null when the selection isn't connected. Callers must say so; there
// is no neighbouring provider that would be a correct substitute.
function laxResolveActiveProvider(data) {
  const providers = data && data.providers;
  if (!Array.isArray(providers)) return null;
  const id = data && data.current && data.current.provider;
  if (!id) return null;
  return providers.find(p => p.id === id) || null;
}

// A providers payload is "complete" once there is nothing further to wait for.
// On a cold boot /api/providers returns instantly but with the Ollama model
// cache still warming server-side, so the selected provider's models come back
// empty — the source of the empty picker boxes. Static-model providers (xAI,
// Anthropic, etc.) are complete on the first hit since their models come from
// the registry, not the warming cache.
function isProvidersComplete(data) {
  if (!data || !Array.isArray(data.providers) || data.providers.length === 0) return false;
  if (!data.current || !data.current.provider) return false;
  const active = laxResolveActiveProvider(data);
  // Selected provider isn't in the list at all — its credential gate failed
  // server-side. No amount of refetching changes that, so the payload IS
  // settled: report complete and let the chip render the disconnected state
  // rather than spin through ensureProvidersLoaded's ten retries every boot.
  if (!active) return true;
  return Array.isArray(active.models) && active.models.length > 0;
}

// Static provider labels — the registry feed is the ONLY one with no credential
// gating, so it's the only thing that can still name a provider the picker has
// dropped. The fetch + cache belong to provider-registry.js (the renderer's one
// reader); this just holds the derived id→label map so the SYNCHRONOUS chip
// render in updateStatusBar can look a name up without awaiting.
let _providerLabels = null;
async function loadProviderLabels() {
  _providerLabels = laxProviderLabels(await laxProviderRegistry());
  return _providerLabels;
}

// Falls back to the raw id rather than inventing a name: an unlabelled "xai"
// is honest, "OpenAI Codex" was not.
function laxProviderLabel(id) {
  if (!id) return '—';
  return (_providerLabels && _providerLabels[id]) || id;
}
