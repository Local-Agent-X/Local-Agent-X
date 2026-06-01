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
