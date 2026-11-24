// Apps page: which apps may talk to your agents, and taking that back.
//
// An app built here can start conversations with the user's agents once the
// user approves it on a card in the inbox (src/routes/app-chat.ts). Those
// conversations run with the user's own powers, so every app that has an
// answer on record shows it on its card, and one click removes it: an allowed
// app loses access at once, and a blocked app may ask again.
//
// apps.js calls decorateAppChatGrants() after it draws the cards; the chat
// socket calls it when another tab or the inbox changes an answer
// (settings_changed, chat-ws-handler-misc.js).

const APP_CHAT_GRANT_TEXT = {
  granted: {
    label: 'Agent access: on',
    title: 'This app can start conversations with your agents, with your full powers. Click to remove that.',
    confirm: (name) => `Stop "${name}" from talking to your agents?\n\nIt loses access now. If it asks again, you will get a new request in your inbox.`,
  },
  denied: {
    label: 'Agent access: blocked',
    title: 'You declined to let this app talk to your agents. Click to let it ask again.',
    confirm: (name) => `Let "${name}" ask again?\n\nIt stays blocked until you approve a new request in your inbox.`,
  },
};

async function decorateAppChatGrants() {
  const grid = document.getElementById('apps-grid');
  if (!grid) return;
  let grants = [];
  try {
    const r = await fetch(`${API}/api/app-chat-grants`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (r.ok) grants = (await r.json()).grants || [];
  } catch { return; }
  grid.querySelectorAll('.app-chat-grant-btn').forEach((el) => el.remove());
  for (const grant of grants) {
    const text = APP_CHAT_GRANT_TEXT[grant.answer];
    const nameEl = grid.querySelector('.app-card-name[data-id="' + CSS.escape(grant.appId) + '"]');
    const actions = nameEl ? nameEl.closest('.app-card').querySelector('.app-card-actions') : null;
    if (!text || !actions) continue;
    const btn = document.createElement('button');
    btn.className = 'app-action-btn app-chat-grant-btn' + (grant.answer === 'granted' ? ' on' : '');
    btn.textContent = text.label;
    btn.title = text.title;
    btn.onclick = () => forgetAppChatGrant(grant.appId, nameEl.textContent || grant.appId, text);
    actions.insertBefore(btn, actions.querySelector('.app-action-btn.danger'));
  }
}

async function forgetAppChatGrant(appId, name, text) {
  if (!confirm(text.confirm(name))) return;
  try {
    const r = await fetch(`${API}/api/app-chat-grants/${encodeURIComponent(appId)}/forget`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  } catch (e) {
    alert('Could not change that: ' + e.message);
  }
  decorateAppChatGrants();
}

window.decorateAppChatGrants = decorateAppChatGrants;
