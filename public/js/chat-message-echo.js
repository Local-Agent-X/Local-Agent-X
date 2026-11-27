// The user's message for a running turn, from whichever device sent it
// (`user_message`, src/types/server-events.ts). The server sends it to every
// client viewing the chat as the turn starts, and again on a replay, so a
// message typed on the phone shows here before the reply is saved with it.
// The client that sent the message already holds it and leaves it alone.

/** A user row's pictures as the renderer draws them: its own attachments, or
 *  the images the server stored on it (`/uploads/<file>`; a message sent from
 *  the phone has only these). */
function userRowAttachments(msg) {
  if (msg.attachments) return msg.attachments;
  if (!Array.isArray(msg.images) || msg.images.length === 0) return undefined;
  return msg.images.map(im => ({ name: im.name || 'image', url: im.url, isImage: true, size: 0, type: '' }));
}

/** What the user typed, for telling one message from another: the "Attached
 *  files" preamble the desktop adds is not part of it. */
function _echoComparable(content) {
  return String(typeof content === 'string' ? content : '').replace(/^Attached files:\n[\s\S]*?\n\n/, '').trim();
}

function handleUserMessageEcho(msg) {
  try {
    const sid = msg.sessionId;
    const ev = msg.event || {};
    const chat = (typeof chats !== 'undefined' && Array.isArray(chats)) ? chats.find(c => c.id === sid) : null;
    if (!chat || !Array.isArray(chat.messages) || typeof ev.text !== 'string') return true;
    // The rows since the last reply are this turn's: the message is shown when one matches.
    const text = _echoComparable(ev.text);
    for (let i = chat.messages.length - 1; i >= 0 && chat.messages[i].role !== 'assistant'; i--) {
      const row = chat.messages[i];
      if (row && row.role === 'user' && _echoComparable(row.content) === text) return true;
    }
    const row = { role: 'user', content: ev.text, timestamp: Date.now() };
    const attachments = userRowAttachments({ images: ev.images });
    if (attachments) row.attachments = attachments;
    chat.messages.push(row);
    if (typeof saveChats === 'function') saveChats();
    if (typeof activeChat !== 'undefined' && activeChat && activeChat.id === sid && typeof renderMessages === 'function') {
      renderMessages();
    }
    return true;
  } catch (e) {
    console.warn('[user_message] failed to show the message', e);
    return false;
  }
}
