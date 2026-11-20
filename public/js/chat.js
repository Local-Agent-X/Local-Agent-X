// ── Chat Panel ──
// Per-session stream state lives in ChatStreamStore (chat-stream-store.js).
// `isStreaming(id)` is the canonical "is X streaming" query — both the
// legacy singular streamingSessionId and the local _liveStreams Map were
// folded into the store as part of the Phase 1 client refactor.

let pendingUploads = [];
let userScrolledUp = false;

function isStreaming(sessionId) {
  return !!sessionId && ChatStreamStore.isStreaming(sessionId);
}
window.isStreaming = isStreaming;

// Broader than isStreaming: true while streaming OR while the session carries a
// server-active marker (running bg op). Guards that protect in-memory state
// from a racing server sync/hydrate key on this so they also cover the brief
// finalize window where status has flipped off 'streaming' but the turn isn't
// yet persisted server-side.
function isActive(sessionId) {
  return !!sessionId && ChatStreamStore.isActive(sessionId);
}
window.isActive = isActive;

function init_chat() {
  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.disabled = false;
  window._chatScrollBottomNext = true;
  renderMessages(); initStatusBar(); _renderAgentFeedsList();
}


// ═══════════════════════════════════════════════
// Feature 1: Conversation Branching
// ═══════════════════════════════════════════════

async function forkAtMessage(msgIndex) {
  if (!activeChat) return;
  try {
    const res = await apiFetch('/api/sessions/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeChat.id, atIndex: msgIndex }),
    });
    const data = await res.json();
    if (data.ok) {
      // Add the forked session to our chat list
      const forkChat = {
        id: data.forkId,
        title: data.title,
        messages: activeChat.messages.slice(0, msgIndex + 1).map(m => ({ role: m.role, content: m.content })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        forkedFrom: activeChat.id,
        forkAtIndex: msgIndex,
      };
      chats.unshift(forkChat);
      saveChats();
      renderSidebar();
      selectChat(data.forkId);
    }
  } catch (e) {
    console.warn('[fork] Error:', e.message);
  }
}

// The first turn of a session opened from a handoff, sent as the user's.
function startFromHandoff(brief) {
  const input = document.getElementById('msg-input');
  if (!input || typeof sendMessage !== 'function') return;
  input.value = `Continue the work from the handoff brief ${brief}: pick up the next step it lists, and ask me before anything it says needs my OK.`;
  sendMessage();
}

// The chat's latest Code mode handoff offer (the agent's code_handoff notice), or null.
function latestHandoffOf(chat) {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const n = (chat.messages[i]._notices || []).find(x => x && x.kind === 'handoff' && x.folder && x.brief);
    if (n) return n;
  }
  return null;
}

/**
 * The sidebar's "Continue in a code session". A code session works in one repo
 * folder, so it goes through the handoff: the chat's latest offer opens at
 * once; with none, the chat's agent is asked to write the brief and offer it.
 * It used to fork the whole chat into a code session with no folder and no
 * brief, which opened under "No folder" with nothing to work on (2026-11-20).
 */
async function moveChatToCode(chatId, e) {
  if (e) e.stopPropagation();
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;
  if (chat._needsHydrate && typeof hydrateChat === 'function') { try { await hydrateChat(chat); } catch {} }
  const offer = latestHandoffOf(chat);
  if (offer && await continueInCodeSession(chat.id, null, { folder: offer.folder, brief: offer.brief })) {
    offer.status = 'opened';
    saveChats();
    return;
  }
  selectChat(chat.id);
  const input = document.getElementById('msg-input');
  if (!input || typeof sendMessage !== 'function') return;
  input.value = 'Let’s continue this in Code mode: write the handoff brief in the repo and offer it.';
  sendMessage();
}

/**
 * Continue a chat's work as a code session, from the agent's code_handoff
 * offer ({ folder, brief }): a code session (fewer prompt parts, the coding
 * kit up front) on that repo, as its project, starting from the brief rather
 * than the whole chat. A session's mode is fixed at creation, so this is how
 * a chat "switches". Its first turn starts on the brief at once. Resolves
 * true when the session opened.
 */
async function continueInCodeSession(chatId, e, handoff) {
  if (e) e.stopPropagation();
  const chat = chats.find(c => c.id === chatId);
  if (!chat || !chat.messages.length || !handoff) return false;
  try {
    const res = await apiFetch('/api/sessions/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: chat.id, atIndex: chat.messages.length - 1, mode: 'code', handoff }),
    });
    const data = await res.json();
    if (!data.ok) return false;
    let messages = [];
    try {
      const fresh = await (await apiFetch(`/api/sessions/${encodeURIComponent(data.forkId)}/messages`)).json();
      if (Array.isArray(fresh.messages)) messages = fresh.messages.map(m => ({ role: m.role, content: m.content }));
    } catch {}
    const codeChat = {
      id: data.forkId, title: data.title, mode: 'code', messages,
      createdAt: Date.now(), updatedAt: Date.now(),
      forkedFrom: chat.id, forkAtIndex: chat.messages.length - 1,
    };
    const projectId = data.projectId || chat.projectId;
    if (projectId) codeChat.projectId = projectId;
    chats.unshift(codeChat);
    saveChats();
    if (typeof setSidebarMode === 'function') setSidebarMode('code');
    selectChat(data.forkId);
    // The click is the go-ahead: the session starts on the brief rather than
    // opening blank and waiting for the user to say "go" (2026-11-20).
    startFromHandoff(handoff.brief);
    return true;
  } catch (err) {
    console.warn('[continue-in-code] Error:', err.message);
    return false;
  }
}

async function showForkTree() {
  if (!activeChat) return;
  const overlay = document.getElementById('fork-tree-overlay');
  const content = document.getElementById('fork-tree-content');
  if (!overlay || !content) return;
  overlay.style.display = 'flex';
  content.innerHTML = '<div style="color:var(--muted);font-size:.75rem;font-family:var(--mono)">Loading branches...</div>';
  overlay.onclick = (e) => { if (e.target === overlay) closeForkTree(); };

  try {
    const res = await apiFetch(`/api/sessions/forks?sessionId=${encodeURIComponent(activeChat.id)}`);
    const data = await res.json();

    let html = '';
    // Show parent if this is a fork
    if (data.parent) {
      const parentChat = chats.find(c => c.id === data.parent);
      html += `<div class="fork-tree-item" onclick="closeForkTree();selectChat('${esc(data.parent)}')" title="Go to parent">
        <div class="fork-tree-dot" style="background:var(--info)"></div>
        <div class="fork-tree-info">
          <div class="fork-tree-title">${esc(parentChat?.title || data.parent)}</div>
          <div class="fork-tree-meta">PARENT</div>
        </div>
      </div>`;
    }

    // Current session
    html += `<div class="fork-tree-item current">
      <div class="fork-tree-dot"></div>
      <div class="fork-tree-info">
        <div class="fork-tree-title">${esc(activeChat.title)}</div>
        <div class="fork-tree-meta">CURRENT${activeChat.forkedFrom ? ' (branch)' : ''}</div>
      </div>
    </div>`;

    // Child forks
    if (data.forks.length > 0) {
      for (const fork of data.forks) {
        const d = new Date(fork.createdAt).toLocaleDateString();
        html += `<div class="fork-tree-item" onclick="closeForkTree();selectChat('${esc(fork.id)}')" style="margin-left:20px">
          <div class="fork-tree-dot" style="background:var(--warn)"></div>
          <div class="fork-tree-info">
            <div class="fork-tree-title">${esc(fork.title)}</div>
            <div class="fork-tree-meta">Forked at msg #${fork.forkAtIndex} &middot; ${d}</div>
          </div>
        </div>`;
      }
    } else if (!data.parent) {
      html += '<div style="color:var(--muted);font-size:.72rem;font-family:var(--mono);padding:8px 0">No branches yet. Hover a message and click Fork to create one.</div>';
    }

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div style="color:var(--danger);font-size:.75rem">Error loading branches: ${esc(e.message)}</div>`;
  }
}

// ═══════════════════════════════════════════════
// Feature 2: Auto-Summarize Old Sessions
// ═══════════════════════════════════════════════

async function autoSummarize() {
  const btn = event?.target;
  if (btn) { btn.textContent = 'Working...'; btn.disabled = true; }
  try {
    const res = await apiFetch('/api/sessions/auto-summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (btn) {
      btn.textContent = data.summarized > 0 ? `${data.summarized} summarized` : 'Up to date';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = 'Summarize'; }, 3000);
    }
  } catch (e) {
    if (btn) { btn.textContent = 'Error'; btn.disabled = false; setTimeout(() => { btn.textContent = 'Summarize'; }, 2000); }
  }
}

// Global search + smart-context indicator + mood detection moved to /js/chat-extras.js
