// ── Chat: each chat's own model ──
//
// The model picker sets the model of the chat on screen, not every chat's
// (ADR 0007 §8, src/session/model-pin.ts). /api/providers?session=<id> answers
// with that chat's model as `current` (`pinned: true`) and the default a chat
// with none runs on as `default`; POST /api/providers/session-model sets it.
// The Settings page's model picker still sets the default
// (/api/providers/switch).
//
// The provider list is cached for the chat it was fetched for
// (_providersCacheSession, chat-status-bar.js); opening another chat refetches.
//
// External deps: apiFetch (shared.js); _providersCache, _providersCacheTime,
// _providersCacheSession, refreshProviderPicker (chat-status-bar.js).

/** The id of the chat on screen, or '' when none is open. */
function laxChatId() {
  try { return (window.activeChat && window.activeChat.id) || ''; } catch { return ''; }
}

/** /api/providers for the chat on screen. */
function laxProvidersUrl() {
  const id = laxChatId();
  return '/api/providers' + (id ? '?session=' + encodeURIComponent(id) : '');
}

let _laxPinRefetching = false;
/** The cached provider list, refetched in the background when it was fetched
 *  for another chat (the user opened a different one). */
function laxProvidersForChat(cache) {
  if (cache && _providersCacheSession !== laxChatId() && !_laxPinRefetching) {
    _laxPinRefetching = true;
    Promise.resolve(refreshProviderPicker()).finally(() => { _laxPinRefetching = false; });
  }
  return cache;
}

/** The thinking depth the chat on screen runs at. */
function laxChatEffort() {
  const cur = _providersCache && _providersCacheSession === laxChatId() ? _providersCache.current : null;
  if (cur && cur.effort) return cur.effort;
  try { return JSON.parse(localStorage.getItem('lax_settings') || '{}').reasoningEffort || 'medium'; } catch { return 'medium'; }
}

/** Set the chat on screen's model. Returns false when no chat is open, so the
 *  caller sets the default instead. */
async function laxSetChatModel(providerId, model, effort) {
  const sessionId = laxChatId();
  if (!sessionId) return false;
  const body = { sessionId, provider: providerId, model: model || '' };
  if (effort) body.effort = effort;
  const res = await apiFetch('/api/providers/session-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res && !res.ok) throw new Error('session-model ' + res.status);
  _providersCacheTime = 0;
  return true;
}

/** Another tab (or the phone) changed a chat's model: redraw if it is this one. */
function laxOnSessionModelChanged(change) {
  if (!change || change.sessionId !== laxChatId()) return;
  _providersCacheTime = 0;
  try { refreshProviderPicker(); } catch {}
}
