// Learning notices arrive after the turn they concern — the review waits until
// it can see whether the work held up — so they attach to the chat's latest
// assistant row rather than to a live turn, and are saved with that row. The
// session snapshot re-delivers the ones still pending, so a notice sent while
// this window was closed is not lost; a notice already on a row is never added
// twice. Rendered by renderLearningNotice (chat-render-notices.js).
//
// Exposes (global): attachLearningNotices(sessionId, events)

function _learningNoticeFrom(ev) {
  return {
    kind: 'learning',
    id: 'ln-' + ev.id + '-' + ev.versionId,
    candidateId: ev.id,
    versionId: ev.versionId,
    name: String(ev.name || ''),
    description: String(ev.description || ''),
    refinement: !!ev.refinement,
    canReject: !!ev.canReject,
    expectedActiveVersionId: typeof ev.expectedActiveVersionId === 'string' ? ev.expectedActiveVersionId : null,
    status: 'pending',
  };
}

function attachLearningNotices(sessionId, events) {
  const list = (typeof chats !== 'undefined' && Array.isArray(chats)) ? chats : [];
  const chat = list.find((c) => c && c.id === sessionId);
  if (!chat || !Array.isArray(chat.messages)) return false;
  let target = null;
  const seen = new Set();
  for (const m of chat.messages) {
    if (!m) continue;
    if (m.role === 'assistant') target = m;
    for (const n of m._notices || []) seen.add(n.id);
  }
  if (!target) return false;
  let added = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev.id !== 'string' || typeof ev.versionId !== 'string') continue;
    const notice = _learningNoticeFrom(ev);
    if (seen.has(notice.id)) continue;
    seen.add(notice.id);
    (target._notices || (target._notices = [])).push(notice);
    added++;
  }
  if (added === 0) return true;
  try { if (typeof saveChats === 'function') saveChats(); } catch { /* shown this session regardless */ }
  if (typeof activeChat !== 'undefined' && activeChat && activeChat.id === sessionId && typeof renderMessages === 'function') {
    renderMessages();
  }
  return true;
}
