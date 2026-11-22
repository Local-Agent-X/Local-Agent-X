// ── Chat: "Send now" under a message typed while the agent works ──
// A message typed mid-turn is read at the agent's next step. When the agent is
// waiting on a long shell command, that can be minutes. Send now asks the
// server to move that command to the background (it keeps running) so the
// agent reads the message at once (src/tools/shell-handoff.ts). The server
// answers with send_now_result: how many commands it moved. 0 means the agent
// is on another kind of step and reads the message when that step ends.
//
// Globals used: activeChat, chatWs, ChatStreamStore, rerenderLiveMessage.

const SEND_NOW_LABELS = {
  sending: 'Sending…',
  moved: 'Sent: the agent is reading it now',
  waiting: 'The agent reads it when its current step ends',
};

/** The button drawn under a queued inline message (chat-render-artifacts.js). */
function sendNowButton(block) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'inline-inject-send-now';
  btn.textContent = SEND_NOW_LABELS[block.sendNow] || 'Send now';
  btn.disabled = !!block.sendNow;
  btn.title = 'Let the agent read this now. A command it is waiting on keeps running in the background.';
  btn.addEventListener('click', () => sendQueuedNow(block.injectId));
  return btn;
}

function sendQueuedNow(injectId) {
  if (!activeChat || !injectId || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;
  chatWs.send(JSON.stringify({ type: 'send_now', sessionId: activeChat.id, injectId }));
  setSendNowState(activeChat.id, injectId, 'sending');
}

function handleSendNowResult(msg) {
  if (!msg.sessionId || !msg.injectId) return;
  setSendNowState(msg.sessionId, msg.injectId, msg.movedToBackground > 0 ? 'moved' : 'waiting');
}

function setSendNowState(sessionId, injectId, state) {
  if (!ChatStreamStore.markInjectSendNow(sessionId, injectId, state)) return;
  if (typeof rerenderLiveMessage === 'function') rerenderLiveMessage(sessionId);
}

window.sendNowButton = sendNowButton;
window.handleSendNowResult = handleSendNowResult;
