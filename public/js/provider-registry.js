// ── Provider registry — the renderer's one reader ──
//
// GET /api/providers/registry mirrors src/providers/registry.ts: label, model
// list, default model and transport for every provider, with NO credential
// gating (unlike /api/providers, which lists only what's connected). It's
// build-time constant server-side, so the renderer fetches it once and holds it.
//
// Five modules used to read it independently, and they had diverged in ways
// that mattered:
//   - apps-ide.js reached into apps.js's globals (`typeof APPS_PROVIDERS !==
//     'undefined' && ...`) to dodge a second fetch, coupling two pages through
//     a variable name;
//   - cron-actions.js refetched on every missions-modal open;
//   - agents/team.js cached [] on failure, so one failed first-open left the
//     model picker empty for the rest of the session;
//   - each rebuilt the same two <select> shapes by hand.
// All five now call laxProviderRegistry(); the adapters below cover every shape
// they were deriving.
//
// Classic script on purpose. app.html loads it beside the other classic
// scripts, and the ES modules under js/agents/ already read renderer globals
// (API, AUTH_TOKEN), so a global function reaches both worlds — an ES module
// here would not be importable by the classic callers.
//
// External deps (classic-script global): apiFetch (shared-api.js).

var _laxProviderRegistry = null;
var _laxProviderRegistryInFlight = null;

// → Promise<Array<{id, label, models, defaultModel, transport}>>
//
// Concurrent callers share one request (the apps gallery and the IDE picker can
// both initialise on the same tick). A FAILURE IS NOT CACHED: the registry is
// what fills every model picker in the app, and holding an empty result for the
// session over one transient boot error is how agents/team.js used to strand
// its picker until a reload.
async function laxProviderRegistry() {
  if (_laxProviderRegistry) return _laxProviderRegistry;
  if (_laxProviderRegistryInFlight) return _laxProviderRegistryInFlight;
  _laxProviderRegistryInFlight = (async () => {
    try {
      const res = await apiFetch('/api/providers/registry');
      const data = await res.json();
      const providers = Array.isArray(data && data.providers) ? data.providers : [];
      if (providers.length) _laxProviderRegistry = providers;
      return providers;
    } catch {
      return [];
    } finally {
      _laxProviderRegistryInFlight = null;
    }
  })();
  return _laxProviderRegistryInFlight;
}

// ── Shape adapters ──
// Pure, so they're testable without a fetch, and cheap enough to call per
// render rather than caching a second derived copy per module.

/** Options for a provider <select>: [{value, label}]. */
function laxProviderOptions(registry) {
  return (registry || []).map(p => ({ value: p.id, label: p.label }));
}

/** Models keyed by provider id, for the dependent model <select>. */
function laxProviderModels(registry) {
  return Object.fromEntries((registry || []).map(p => [p.id, p.models || []]));
}

/** id → label. Names a provider that /api/providers dropped for lack of a credential. */
function laxProviderLabels(registry) {
  return Object.fromEntries((registry || []).map(p => [p.id, p.label]));
}
