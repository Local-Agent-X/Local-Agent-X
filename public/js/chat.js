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

/**
 * Continue a chat as a code session: a fork of the whole conversation that is
 * a code session (fewer prompt parts, the coding kit up front) in the chat's
 * project folder, compacted first when it is long, so the work goes on with
 * the context the coding needs instead of everything the chat accumulated.
 * A session's mode is fixed at creation, so this is how a chat "switches".
 */
async function continueInCodeSession(chatId, e) {
  if (e) e.stopPropagation();
  const chat = chats.find(c => c.id === chatId);
  if (!chat || !chat.messages.length) return;
  try {
    const res = await apiFetch('/api/sessions/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: chat.id, atIndex: chat.messages.length - 1, mode: 'code' }),
    });
    const data = await res.json();
    if (!data.ok) return;
    let messages = chat.messages.map(m => ({ role: m.role, content: m.content }));
    if (messages.length >= 10) {
      // The same compaction the Compact button runs; the server's transcript is
      // the truth, so the sidebar copy is reloaded from it.
      await apiFetch('/api/compact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: data.forkId }) });
      try {
        const fresh = await (await apiFetch(`/api/sessions/${encodeURIComponent(data.forkId)}/messages`)).json();
        if (Array.isArray(fresh.messages)) messages = fresh.messages.map(m => ({ role: m.role, content: m.content }));
      } catch {}
    }
    const codeChat = {
      id: data.forkId, title: data.title, mode: 'code', messages,
      createdAt: Date.now(), updatedAt: Date.now(),
      forkedFrom: chat.id, forkAtIndex: chat.messages.length - 1,
    };
    if (chat.projectId) codeChat.projectId = chat.projectId;
    chats.unshift(codeChat);
    saveChats();
    if (typeof setSidebarMode === 'function') setSidebarMode('code');
    selectChat(data.forkId);
  } catch (err) {
    console.warn('[continue-in-code] Error:', err.message);
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
