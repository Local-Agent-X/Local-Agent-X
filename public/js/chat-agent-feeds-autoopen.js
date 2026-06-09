// -- Agent Feeds: Auto-open preference --
//
// The AUTO pill in the AGENTS panel header: should the panel pop open
// automatically whenever an agent spawns? User-toggleable, persisted two
// ways (localStorage + server settings.json) so a wiped webview
// localStorage can't lose the user's choice.
//
// Loaded BEFORE chat-agent-feeds.js so `agentFeedsAutoOpen` is defined by
// the time addAgentFeed() reads it. All symbols here are top-level globals
// shared with the core script -- this is a classic browser script, not a
// module.
//
// External deps from shared.js: window.apiPost. Also reads AUTH_TOKEN / API
// (chat.js) at runtime. The core script's agentFeedsOpen / toggleAgentFeeds
// are referenced only at runtime, never at load time.

let agentFeedsOpen = false;
let agentFeedsData = {};
// Auto-open the AGENTS panel whenever an agent spawns. User-toggleable
// via the AUTO pill in the panel header. Persisted two ways so a wiped
// webview localStorage can't lose the user's choice:
//   1. localStorage (fast, in-memory at boot)
//   2. server settings.json via /api/settings (durable, source of truth)
// Boot reads localStorage first for instant correct paint, then hits the
// server async — if the server has a different value, it wins and the
// button re-renders. Default ON to match prior behavior.
let agentFeedsAutoOpen = (function() {
  try { var raw = localStorage.getItem('lax_agent_feeds_autoopen'); return raw === null ? true : raw === '1'; }
  catch { return true; }
})();

function toggleAgentFeedsAutoOpen() {
  agentFeedsAutoOpen = !agentFeedsAutoOpen;
  try { localStorage.setItem('lax_agent_feeds_autoopen', agentFeedsAutoOpen ? '1' : '0'); } catch {}
  // Best-effort server-side persist. Don't block the UI on it — localStorage
  // already covered the fast path. apiPost is defined in shared.js and
  // tolerates the server being down (the toggle still works locally).
  try {
    if (typeof apiPost === 'function') {
      apiPost('/api/settings', { agentFeedsAutoOpen: agentFeedsAutoOpen }).catch(function() {});
    }
  } catch {}
  _updateAutoOpenButton();
}

function _updateAutoOpenButton() {
  var btn = document.getElementById('agent-feeds-autoopen-toggle');
  if (!btn) return;
  if (agentFeedsAutoOpen) { btn.classList.add('on'); btn.classList.remove('off'); btn.title = 'Auto-open ON — panel opens whenever an agent spawns. Click to disable.'; }
  else { btn.classList.add('off'); btn.classList.remove('on'); btn.title = 'Auto-open OFF — panel stays closed when agents spawn. Click to enable.'; }
}

// Pull the server-side value once on boot. If it disagrees with what we
// loaded from localStorage (because localStorage got wiped by a webview
// session reset, but settings.json on disk is still intact), the server
// value wins — that's the durable source of truth.
function _hydrateAutoOpenFromServer() {
  try {
    if (typeof fetch !== 'function') return;
    var headers = {};
    if (typeof AUTH_TOKEN !== 'undefined' && AUTH_TOKEN) headers.Authorization = 'Bearer ' + AUTH_TOKEN;
    fetch((typeof API !== 'undefined' ? API : '') + '/api/settings', { headers: headers })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || typeof data.agentFeedsAutoOpen !== 'boolean') return;
        if (data.agentFeedsAutoOpen === agentFeedsAutoOpen) return;
        agentFeedsAutoOpen = data.agentFeedsAutoOpen;
        try { localStorage.setItem('lax_agent_feeds_autoopen', agentFeedsAutoOpen ? '1' : '0'); } catch {}
        _updateAutoOpenButton();
      })
      .catch(function() {});
  } catch {}
}

// Sync the button visual to the persisted state once the DOM is ready.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { _updateAutoOpenButton(); _hydrateAutoOpenFromServer(); });
  } else {
    _updateAutoOpenButton();
    _hydrateAutoOpenFromServer();
  }
}
