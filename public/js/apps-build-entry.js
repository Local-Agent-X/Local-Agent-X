// Apps-tab "build an app" entry points — split out of apps.js (god-file at the
// 400-LOC gate). The dedicated Apps surface signals serious intent, so the
// primary action routes to the GUIDED /app-build skill in a fresh chat
// (spec-first, asks questions, can go full-stack). ⚡ Quick is the escape hatch
// for an instant one-shot HTML app in the IDE. Slash expansion + the
// intent-classifier skip happen server-side. Both rely on globals: enterIdeView
// (apps.js) and newChat / sendMessage (chat layer).

function sendAppsChatMessage() {
  const input = document.getElementById('apps-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (typeof newChat === 'function') newChat();
  const msg = document.getElementById('msg-input');
  if (msg) {
    msg.value = '/app-build ' + text;
    if (typeof sendMessage === 'function') sendMessage();
  }
}

// Quick escape: an instant one-shot HTML app in the IDE — no questions asked.
function sendAppsChatQuick() {
  const input = document.getElementById('apps-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const slug = text.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-app';
  enterIdeView(slug, text.slice(0, 50), null, text);
}

window.sendAppsChatMessage = sendAppsChatMessage;
window.sendAppsChatQuick = sendAppsChatQuick;
