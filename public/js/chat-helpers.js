// ── Chat: Helpers (compaction / md toggle / worker bubbles / messageEl / lightbox) ──
//
// Grab-bag of chat-page helpers that share no obvious larger module:
//   - compactChat + the markdown-preview toggle (feature 90)
//   - formatMsgTime (used by render path)
//   - ensureWorkerBubble + appendStaticWorkerBubble + _workerBubbles state
//     (legacy hold-over from JARVIS-mode worker_stream rendering — left
//     intact for now; renderMessages still uses appendStaticWorkerBubble
//     for persisted _worker rows from before that path was suppressed.)
//   - addMessageEl (the workhorse DOM builder for every message bubble)
//   - openLightbox (image preview overlay)
//
// Extracted from chat.js as part of the 400-LOC god-file split.
//
// External deps from chat.js / shared.js:
//   - apiFetch, esc, md          (shared.js)
//   - activeChat, saveChats      (app.js)
//   - autoScroll, renderMessages, updateContextBar (chat.js — auto-window)

// ── Context compaction (like Claude Code) ──
// Keeps full chat visible in UI, but tells the server to summarize old messages
// for the AI. The chat record on disk stays complete.
async function compactChat() {
  if (!activeChat) return;
  console.log('[compact] Starting compact for', activeChat.id, 'with', activeChat.messages.length, 'frontend messages');

  const bar = document.getElementById('context-bar');
  if (bar) bar.innerHTML = '<span class="ctx-dot yellow"></span><span class="ctx-text">Compacting context...</span>';

  try {
    const res = await apiFetch('/api/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeChat.id }),
    });
    const data = await res.json();
    console.log('[compact] Response:', data);
    if (data.ok) {
      activeChat.compactedAt = data.compactedAt || activeChat.messages.length - 20;
      saveChats();

      // Show compaction marker in chat
      const el = document.getElementById('messages');
      const marker = document.createElement('div');
      marker.style.cssText = 'text-align:center;padding:12px;font-family:var(--mono);font-size:.7rem;color:var(--accent);border-top:1px dashed var(--border);border-bottom:1px dashed var(--border);margin:12px 0';
      marker.textContent = `— context compacted — ${data.oldCount} old messages summarized, ${data.recentCount} kept in full —`;
      el.appendChild(marker);
      autoScroll();
    } else {
      console.warn('[compact] Not compacted:', data.reason);
      if (bar) bar.innerHTML = `<span class="ctx-dot yellow"></span><span class="ctx-text">${esc(data.reason || 'Compact failed')}</span>`;
    }
  } catch (e) {
    console.warn('Compact failed:', e);
    if (bar) bar.innerHTML = `<span class="ctx-dot red"></span><span class="ctx-text">Compact error: ${esc(e.message)}</span>`;
  }
  updateContextBar();
}

// Markdown preview toggle state (feature 90)
let mdPreviewMode = true; // true = rendered, false = raw

function toggleMdPreview() {
  mdPreviewMode = !mdPreviewMode;
  const btn = document.getElementById('md-toggle-btn');
  if (btn) { btn.textContent = mdPreviewMode ? 'Raw' : 'Preview'; btn.title = mdPreviewMode ? 'Show raw markdown' : 'Show rendered markdown'; }
  renderMessages();
}

function formatMsgTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return time;
  if (days === 1) return 'Yesterday ' + time;
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

// Worker bubbles — Step 1 of JARVIS-mode. Per-opId map of the streaming
// chat bubbles owned by background workers. Created lazily on first
// worker_stream event for an opId, finalized on worker_done. Lives
// outside chat.activeChat.messages because workers can stream
// independent of the main agent's turn boundary.
const _workerBubbles = new Map(); // opId -> { div, content, contentEl }

function ensureWorkerBubble(opId, taskHint) {
  if (_workerBubbles.has(opId)) return _workerBubbles.get(opId);
  const el = document.getElementById('messages');
  if (!el) return null;
  // Use the assistant-bubble layout so the worker message flows inline
  // with chat. Previously inline styles + raw <pre> placement caused the
  // bubble to render way below other messages with weird spacing.
  const div = document.createElement('div');
  div.className = 'msg assistant worker-bubble streaming';
  div.setAttribute('role', 'article');
  div.setAttribute('aria-label', 'Worker message');
  div.dataset.opId = opId;
  const labelText = taskHint ? `⚙ Worker — ${esc(taskHint)}` : '⚙ Worker';
  div.innerHTML =
    `<div class="msg-label">${labelText}</div>` +
    `<div class="msg-body"><div class="worker-content"></div></div>` +
    `<div class="msg-footer"></div>`;
  // One-time CSS for worker tinting — keeps the visual distinct from
  // main agent without a stylesheet migration.
  const styleId = '_workerBubbleCSS';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent =
      '.msg.assistant.worker-bubble .msg-label{color:#9d9bff}' +
      '.msg.assistant.worker-bubble .msg-body{border-left:2px solid #4a4870;padding-left:10px;opacity:.92}' +
      '.msg.assistant.worker-bubble .worker-content{white-space:pre-wrap;font-size:.92rem;line-height:1.45}';
    document.head.appendChild(s);
  }
  el.appendChild(div);
  // Migrate pin-bottom to this worker bubble so the prior assistant
  // ("Kicking off ..." reply) doesn't keep its ~100vh viewport reservation
  // below it, which would push the worker stream way down the page and
  // visually separate the kickoff message from the worker output.
  document.querySelectorAll('.msg.assistant.pin-bottom').forEach(prev => prev.classList.remove('pin-bottom'));
  div.classList.add('pin-bottom');
  if (typeof Spring !== 'undefined') {
    try { Spring.fadeIn(div, { preset: 'stiff', slide: true, slideFrom: 8 }); } catch {}
  }
  try { el.scrollTop = el.scrollHeight; } catch {}
  const contentEl = div.querySelector('.worker-content');
  const entry = { div, content: '', contentEl, taskHint: taskHint || null };
  _workerBubbles.set(opId, entry);
  return entry;
}

// Static worker-bubble for renderMessages — recreates a finished worker
// bubble from a persisted activeChat.messages entry (msg._worker === true).
// Mirrors ensureWorkerBubble's DOM shape but without the streaming class
// or the in-flight registry. Used after a worker_done has copied content
// into messages so subsequent renderMessages() calls keep the bubble.
function appendStaticWorkerBubble(opId, content, taskHint, status) {
  const el = document.getElementById('messages');
  if (!el) return null;
  const div = document.createElement('div');
  div.className = 'msg assistant worker-bubble done status-' + (status || 'completed');
  div.setAttribute('role', 'article');
  div.setAttribute('aria-label', 'Worker message');
  if (opId) div.dataset.opId = opId;
  const labelText = taskHint ? `⚙ Worker — ${esc(taskHint)}` : '⚙ Worker';
  div.innerHTML =
    `<div class="msg-label">${labelText}</div>` +
    `<div class="msg-body"><div class="worker-content"></div></div>` +
    `<div class="msg-footer"></div>`;
  const contentEl = div.querySelector('.worker-content');
  if (contentEl) contentEl.textContent = content || '';
  el.appendChild(div);
  return div;
}

function addMessageEl(role, text, attachments) {
  const el = document.getElementById('messages');
  const div = document.createElement('div'); div.className = 'msg ' + role;
  div.setAttribute('role', 'article');
  div.setAttribute('aria-label', role === 'user' ? 'Your message' : 'Assistant message');
  let attachHtml = '';
  if (attachments && attachments.length) {
    attachHtml = '<div class="msg-attachments">' + attachments.map(a => {
      if (a.isImage && a.dataUrl) {
        return `<img src="${esc(a.dataUrl)}" alt="${esc(a.name)}" onclick="openLightbox(this.src)" title="${esc(a.name)}" loading="lazy" />`;
      } else if (a.isImage && a.url) {
        const authedUrl = a.url + (a.url.includes('?') ? '&' : '?') + 'token=' + AUTH_TOKEN;
        return `<img src="${esc(authedUrl)}" alt="${esc(a.name)}" onclick="openLightbox(this.src)" title="${esc(a.name)}" loading="lazy" />`;
      } else if (a.isImage) {
        return `<div class="att-badge"><span>&#128444;</span> ${esc(a.name)}</div>`;
      } else {
        return `<div class="att-badge"><span>&#128196;</span> ${esc(a.name)} (${(a.size / 1024).toFixed(1)}KB)</div>`;
      }
    }).join('') + '</div>';
  }
  const bodyContent = role === 'assistant' ? (mdPreviewMode ? md(text) : `<pre class="raw-md">${esc(text)}</pre>`) : esc(text);
  // Timestamp
  const ts = arguments[3]; // optional 4th arg: timestamp
  const timeStr = ts ? formatMsgTime(ts) : '';
  const timeHtml = timeStr ? `<span class="msg-time">${timeStr}</span>` : '';
  div.innerHTML = `<div class="msg-label">${role === 'user' ? 'You' : 'Assistant'}</div><div class="msg-body">${attachHtml}${bodyContent}</div><div class="msg-footer">${timeHtml}</div>`;
  el.appendChild(div);
  // Migrate the viewport-height pin to the newest assistant bubble. Without
  // this, an agent-emitted follow-up message (build progress, multi-stage
  // reply, op-status update — anything that doesn't go through the user-send
  // flow) lands below the prior bubble's reserved 100vh-of-room and shows
  // up as a giant gap between the two messages.
  if (role === 'assistant') {
    document.querySelectorAll('.msg.assistant.pin-bottom').forEach(prev => prev.classList.remove('pin-bottom'));
    div.classList.add('pin-bottom');
  }
  // Spring entrance for new messages
  if (typeof Spring !== 'undefined') {
    Spring.fadeIn(div, { preset: 'stiff', slide: true, slideFrom: 8 });
  }
  // Scroll after images load (they change height)
  const imgs = div.querySelectorAll('.msg-attachments img');
  if (imgs.length) {
    imgs.forEach(img => img.onload = () => autoScroll());
  }
  autoScroll();
  return div;
}

function openLightbox(src) {
  let lb = document.getElementById('img-preview-overlay');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'img-preview-overlay';
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:10000;cursor:zoom-out;backdrop-filter:blur(4px)';
    lb.onclick = () => lb.style.display = 'none';
    document.body.appendChild(lb);
  }
  lb.textContent = '';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 0 40px rgba(0,0,0,.5)';
  lb.appendChild(img);
  lb.style.display = 'flex';
}

// ──────────────────

