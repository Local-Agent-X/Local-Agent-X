// ── Chat: Uploads + Drag/drop + Paste + Keyboard shortcuts ──
//
// Everything that puts files into pendingUploads:
//   - file picker   (triggerUpload, handleFileUpload)
//   - drag & drop   (initDragDrop)
//   - clipboard paste (paste handler)
// Plus the small keyboard shortcut bindings that were sandwiched in here.
//
// Extracted from chat.js as part of the 400-LOC god-file split.
//
// External deps from chat.js / shared.js:
//   - apiFetch, esc, AUTH_TOKEN  (shared.js)
//   - pendingUploads             (chat.js — closure-bound at call time)
//   - sendMessage                (chat-send.js — auto-window)
//   - retryMessage, showRetryError (chat.js — auto-window)
//   - isVoiceModeActive, stopVoiceMode, stopSpeaking (chat-voice.js)
//   - openGlobalSearch, closeGlobalSearch (chat-extras.js)

// ── Upload ──
// ── Retry with error hints ──
function showRetryError(el, originalMessage, errorMsg) {
  let hint = 'Check your internet connection and try again.';
  if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) hint = 'The server took too long to respond. It may be processing a heavy task — try again in a moment.';
  else if (errorMsg.includes('Failed to fetch') || errorMsg.includes('network')) hint = 'Could not reach the server. Make sure Local Agent X is running.';
  else if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) hint = 'Authentication failed. Try refreshing the page.';
  else if (errorMsg.includes('429')) hint = 'Too many requests. Wait a moment and try again.';
  else if (errorMsg.includes('500') || errorMsg.includes('Internal')) hint = 'Server error. Check the server logs for details.';

  el.innerHTML = `<div class="error-retry">
    <div style="color:var(--danger);font-size:.82rem;margin-bottom:6px">Something went wrong</div>
    <div style="color:var(--muted);font-size:.75rem;margin-bottom:12px">${esc(hint)}</div>
    <button class="action-btn primary" style="font-size:.75rem;padding:6px 16px">Retry</button>
  </div>`;
  // Wire retry via a listener, not an inline onclick: originalMessage stays a
  // closure variable and is never interpolated into HTML, so there is no
  // string-in-attribute injection vector (the old onclick was XSS-prone).
  const retryBtn = el.querySelector('.error-retry button');
  if (retryBtn) retryBtn.addEventListener('click', () => retryMessage(originalMessage));
}

function retryMessage(text) {
  const input = document.getElementById('msg-input');
  if (input) { input.value = text; }
  sendMessage();
}

// ── Multi-surface upload context registry ──
// Each chat surface (main chat, IDE chat) registers a context here. All upload
// functions below take an optional ctxKey ('main' | 'ide') and resolve the
// DOM ids + the pendingUploads array via the context. Default 'main' keeps
// existing HTML onclick="triggerUpload()" call sites working unchanged.
window.__uploadContexts = window.__uploadContexts || {};
window.__uploadContexts.main = {
  fileInputId: 'file-input',
  previewsId: 'upload-previews',
  // Lazy getter — `pendingUploads` is declared in chat.js which loads after
  // this file; the binding only needs to resolve at call time.
  getState: () => pendingUploads,
  setState: (arr) => { pendingUploads = arr; },
};
function __uploadCtx(ctxKey) { return window.__uploadContexts[ctxKey || 'main'] || window.__uploadContexts.main; }
function __uploadState(ctxKey) { return __uploadCtx(ctxKey).getState() || []; }

function triggerUpload(ctxKey) {
  document.getElementById(__uploadCtx(ctxKey).fileInputId)?.click();
}
function handleFileUpload(event, ctxKey) {
  addFilesToUpload(Array.from(event.target.files || []), ctxKey);
}

function renderUploadPreviews(ctxKey) {
  const key = ctxKey || 'main';
  const ctx = __uploadCtx(key);
  const bar = document.getElementById(ctx.previewsId);
  if (!bar) return;
  const list = __uploadState(key);
  if (list.length === 0) { bar.classList.remove('has-items'); bar.innerHTML = ''; return; }
  bar.classList.add('has-items');
  bar.innerHTML = list.map((f, i) => {
    if (f.dataUrl) {
      return `<div style="position:relative;width:140px;height:110px;border-radius:10px;overflow:hidden;background:#111;border:1px solid var(--border);cursor:pointer;flex-shrink:0" onclick="previewImage('${i}','${key}')">
        <img src="${f.dataUrl}" style="width:100%;height:100%;object-fit:cover"/>
        <button onclick="event.stopPropagation();removeUpload(${i},'${key}')" style="position:absolute;top:5px;right:5px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.65);border:none;color:#fff;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)">&times;</button>
      </div>`;
    }
    return `<div style="position:relative;display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;flex-shrink:0;min-width:180px">
      <div style="width:36px;height:36px;border-radius:8px;background:#1a1a30;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0">&#128196;</div>
      <div style="min-width:0"><div style="font-size:.78rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${esc(f.name)}</div><div style="font-size:.65rem;color:var(--muted)">${f.type || 'File'}</div></div>
      <button onclick="removeUpload(${i},'${key}')" style="position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center">&times;</button>
    </div>`;
  }).join('');
}

// Voice mode + Dictate mode + Browser TTS moved to /js/chat-voice.js


// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  if (e.code === 'Escape') { if (isVoiceModeActive()) stopVoiceMode(); else stopSpeaking(); }
});

// Auto-resize textarea
document.getElementById('msg-input')?.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 200) + 'px'; });

// ── Paste handling (images + files from clipboard) ──
// Route by which surface the user is in: IDE fullscreen → IDE chat, else main.
// Mirrors how dictate routes by detecting the active input.
function __activePasteCtxKey() {
  if (document.body && document.body.classList.contains('ide-fullscreen')) return 'ide';
  return 'main';
}
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    addFilesToUpload(files, __activePasteCtxKey());
  }
});

// ── Drag & drop (feature 93: works anywhere in main area) ──
// Configurable per surface: pass dropZoneId + ctxKey + overlayId to mount a
// second drop target on the IDE chat panel. Default behavior unchanged for
// the main chat (dropZone falls back to #main or #page-chat; auto-navigate
// to chat on drop).
function initDragDrop(opts) {
  const cfg = opts || {};
  const ctxKey = cfg.ctxKey || 'main';
  const overlayId = cfg.overlayId || 'drop-overlay';
  const dropZone = cfg.dropZoneId
    ? document.getElementById(cfg.dropZoneId)
    : (document.getElementById('main') || document.getElementById('page-chat'));
  if (!dropZone) return;
  let dragCounter = 0;

  // Create drop overlay
  let dropOverlay = document.getElementById(overlayId);
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.id = overlayId;
    dropOverlay.innerHTML = '<div class="drop-overlay-content"><span class="drop-icon">&#128206;</span><span>Drop files to attach</span></div>';
    dropZone.appendChild(dropOverlay);
  }

  dropZone.addEventListener('dragenter', (e) => {
    // Only show file drop overlay if dragging actual files (not internal drags like org chart)
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.add('visible');
  });
  dropZone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('visible'); }
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) {
      // Navigate to chat if not already there — only for the main surface;
      // an IDE drop should stay in the IDE.
      if (ctxKey === 'main' && typeof currentRoute === 'function' && currentRoute() !== 'chat') navigate('chat');
      addFilesToUpload(files, ctxKey);
    }
  });
}
initDragDrop();
// IDE drop zone: panel exists in the DOM at page load (hidden until user
// enters IDE view), so wiring it now is safe; events only fire once the
// panel is visible.
initDragDrop({ dropZoneId: 'ide-chat-panel', ctxKey: 'ide', overlayId: 'ide-drop-overlay' });

async function addFilesToUpload(files, ctxKey) {
  const key = ctxKey || 'main';
  const list = __uploadState(key);
  for (const f of files) {
    const isImage = f.type.startsWith('image/');
    const entry = { name: f.name, size: f.size, type: f.type, isImage, url: null, dataUrl: null, _uploadPromise: null };

    // Local preview for images
    if (isImage) {
      const reader = new FileReader();
      reader.onload = () => { entry.dataUrl = reader.result; renderUploadPreviews(key); };
      reader.readAsDataURL(f);
    }

    list.push(entry);
    renderUploadPreviews(key);

    // Upload to server in background — track the promise so sendMessage can await it
    const form = new FormData();
    form.append('file', f);
    entry._uploadPromise = (async () => {
      try {
        const res = await apiFetch('/api/upload', { method: 'POST', body: form, headers: {} });
        const data = await res.json();
        if (data.files && data.files[0]) entry.url = data.files[0].url;
      } catch (e) { console.warn('Upload failed:', e); }
    })();
  }
}

function removeUpload(index, ctxKey) {
  const key = ctxKey || 'main';
  __uploadState(key).splice(index, 1);
  renderUploadPreviews(key);
}

function previewImage(index, ctxKey) {
  const key = ctxKey || 'main';
  const f = __uploadState(key)[index];
  if (!f?.dataUrl) return;
  let overlay = document.getElementById('img-preview-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'img-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:10000;cursor:pointer;backdrop-filter:blur(4px)';
    overlay.onclick = () => overlay.style.display = 'none';
    document.body.appendChild(overlay);
  }
  overlay.textContent = '';
  var prevImg = document.createElement('img');
  prevImg.src = f.dataUrl;
  prevImg.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 0 40px rgba(0,0,0,.5)';
  overlay.appendChild(prevImg);
  overlay.style.display = 'flex';
}

// Status bar + context bar moved to /js/chat-status-bar.js
// Voice + clone modals moved to /js/chat-voice-modals.js


// Single source of truth for "is a turn in flight for the chat I'm looking at"
// → drives the toolbar STREAMING indicator + the send-btn inject-mode style.
// Subscribed to ChatStreamStore so every store mutation re-evaluates the
// active-chat UI; concurrent streams (main chat + IDE chat) each get correct
// UI for their own active view because the predicate is per-session.
function updateStreamUI() {
  try {
    const active = (typeof window !== 'undefined' && window.activeChat) ? window.activeChat : null;
    const isStreamingHere = !!(active && typeof window.isStreaming === 'function' && window.isStreaming(active.id));
    const ind = document.getElementById('stream-indicator');
    if (ind) ind.style.display = isStreamingHere ? 'inline-flex' : 'none';
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) {
      sendBtn.classList.toggle('inject-mode', isStreamingHere);
      sendBtn.title = isStreamingHere
        ? 'Inject into the running turn (it is still working)'
        : 'Send message';
      sendBtn.innerHTML = isStreamingHere ? '&#8629;' : '&#9650;';
    }
  } catch {}
}
window.updateStreamUI = updateStreamUI;
try { ChatStreamStore.subscribeAll(function() { updateStreamUI(); }); } catch {}
// (extracted to /js/chat-ws.js or /js/chat-helpers.js)






// Mirrored on window so the status-bar code path can read it from outside
// chat.js's lexical scope. Updated by the token-based updateContextBar
// (further up) when a `context_status` event arrives over the chat WS.
window.lastContextStatus = null;

// Agent Feeds (Mission Control) lives in /js/chat-agent-feeds.js.
// chat-agent-feeds.js calls window.sendChatWsControl(payload) for any
// agent-related WS message — defined here so that module never touches
// chat WS state directly. Returns true if the WS was open (caller may
// fall back to HTTP).
// (extracted to /js/chat-ws.js or /js/chat-helpers.js)



// Agent feed events are now handled inline in chatWs.onmessage (no monkey-patching)

// Init chat on page load
