// ── App IDE — runtime error pipe ──
// Captures uncaught errors, unhandled promise rejections, and console.error
// from inside the preview iframe (same-origin, sandbox allows it), surfaces
// them as red chat bubbles, and prepends a fresh-since-last-turn summary to
// the next user message so the agent sees what's broken instead of being
// told "Done" while the app is throwing.
//
// Injection pattern mirrors apps-ide-picker.js — stringified IIFE dropped
// into the iframe's document, idempotent via window.__laxErrorPipe flag.

// Buffer of unread errors keyed by a hash of {message, source, line, col}.
// Each entry: { key, kind, message, stack, source, line, col, count, ts, el }
// `el` points at the rendered chat bubble so repeats can bump its count badge
// instead of appending a new bubble.
const _ideErrorBuffer = new Map();
// Short window in which an identical error collapses into one bubble rather
// than spawning a new one. After this elapses we let a new bubble appear so
// the user can tell a fresh failure happened.
const _IDE_ERROR_DEDUP_MS = 60_000;

function _ideInjectErrorPipe() {
  const frame = document.getElementById('ide-preview-frame');
  if (!frame) return;
  let doc;
  try { doc = frame.contentDocument; } catch { return; }
  if (!doc || !doc.body || !doc.documentElement) return;
  try { if (frame.contentWindow && frame.contentWindow.__laxErrorPipe) return; } catch { return; }
  const s = doc.createElement('script');
  s.id = '__lax-error-pipe-script';
  s.textContent = _ideErrorPipeSource();
  doc.documentElement.appendChild(s);
}

// Called from enterIdeView / _ideDoRefresh on iframe load. Pairs with the
// picker's _ideOnPreviewLoad — both want a fresh inject every new document.
function _ideOnPreviewLoadErrors() {
  _ideInjectErrorPipe();
}

window.addEventListener('message', (e) => {
  const d = e && e.data;
  if (!d || d.type !== 'lax-ide-runtime-error') return;
  _ideHandleRuntimeError(d);
});

function _ideHandleRuntimeError(d) {
  const message = typeof d.message === 'string' ? d.message : String(d.message || 'Unknown error');
  const source = _ideNormalizeSource(d.source);
  const line = Number.isFinite(d.line) ? d.line : 0;
  const col = Number.isFinite(d.col) ? d.col : 0;
  const kind = d.kind || 'error';
  const key = kind + '|' + message + '|' + source + '|' + line + '|' + col;
  const now = Date.now();
  const prev = _ideErrorBuffer.get(key);
  if (prev && (now - prev.ts) < _IDE_ERROR_DEDUP_MS) {
    prev.count += 1;
    prev.ts = now;
    _ideUpdateErrorBubbleCount(prev);
    // Server-side render-verify gate also needs the repeat — without
    // pushing again, a real second occurrence within the dedup window
    // gets dropped from the gate's view of the world. The client buffer
    // dedups visually; the server treats each push as a fresh signal.
    _ideForwardRuntimeErrorToServer(kind, message, source, line, col, d.stack);
    return;
  }
  const entry = {
    key, kind, message,
    stack: typeof d.stack === 'string' ? d.stack : '',
    source, line, col,
    count: 1, ts: now, el: null,
    sentToServer: false,
  };
  _ideErrorBuffer.set(key, entry);
  entry.el = _ideRenderErrorBubble(entry);
  _ideForwardRuntimeErrorToServer(kind, message, source, line, col, entry.stack);
  entry.sentToServer = true;
}

// Push the error into the per-op server-side render-verify buffer so the
// canonical loop's post-turn gate can see it and force the agent to fix
// it. Best-effort — if the WS isn't open or the session isn't set we
// silently skip (the visual bubble + next-message prefix path still
// works as the user-driven fallback).
function _ideForwardRuntimeErrorToServer(kind, message, source, line, col, stack) {
  try {
    if (typeof chatWs === 'undefined' || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;
    if (typeof _ideSessionId === 'undefined' || !_ideSessionId) return;
    chatWs.send(JSON.stringify({
      type: 'ide_runtime_error',
      sessionId: _ideSessionId,
      kind, message, source, line, col,
      stack: stack || '',
      ts: Date.now(),
    }));
  } catch {}
}

function _ideNormalizeSource(src) {
  if (!src || typeof src !== 'string') return '[unknown source]';
  // Drop the cache-busting query the preview reload appends so repeats dedup
  const q = src.indexOf('?');
  const clean = q >= 0 ? src.slice(0, q) : src;
  // Just the filename — full http://127.0.0.1:PORT/apps/ID/foo.js paths are
  // noise in the bubble. Agent gets the original source string anyway.
  const slash = clean.lastIndexOf('/');
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  return name || '[unknown source]';
}

function _ideRenderErrorBubble(entry) {
  const msgs = document.getElementById('ide-chat-messages');
  if (!msgs) return null;
  const el = document.createElement('div');
  el.className = 'ide-msg ide-runtime-error';
  el.innerHTML = _ideErrorBubbleHTML(entry);
  // Click the header to expand/collapse the stack
  el.addEventListener('click', (ev) => {
    if (ev.target && ev.target.classList && ev.target.classList.contains('ide-err-clear')) return;
    el.classList.toggle('open');
  });
  const clearBtn = el.querySelector('.ide-err-clear');
  if (clearBtn) clearBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    _ideErrorBuffer.delete(entry.key);
    if (el.parentNode) el.parentNode.removeChild(el);
  });
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}

function _ideUpdateErrorBubbleCount(entry) {
  if (!entry.el) return;
  const badge = entry.el.querySelector('.ide-err-count');
  if (!badge) return;
  badge.textContent = '×' + entry.count;
  badge.style.display = '';
}

function _ideErrorBubbleHTML(entry) {
  const label = entry.kind === 'rejection' ? 'Unhandled rejection'
              : entry.kind === 'console' ? 'console.error'
              : entry.kind === 'csp' ? 'CSP violation'
              : entry.kind === 'resource' ? 'Resource error'
              : entry.kind === 'blank' ? 'Empty render'
              : 'Runtime error';
  const where = entry.source + (entry.line ? (':' + entry.line + (entry.col ? ':' + entry.col : '')) : '');
  const countHidden = entry.count > 1 ? '' : 'display:none';
  const stack = entry.stack ? _ideEscapeHTML(entry.stack) : '';
  return (
    '<div class="ide-err-head">' +
      '<span class="ide-err-label">' + label + '</span>' +
      '<span class="ide-err-count" style="' + countHidden + '">×' + entry.count + '</span>' +
      '<button class="ide-err-clear" title="Dismiss" type="button">&times;</button>' +
    '</div>' +
    '<div class="ide-err-msg">' + _ideEscapeHTML(entry.message) + '</div>' +
    '<div class="ide-err-where">' + _ideEscapeHTML(where) + '</div>' +
    (stack ? '<pre class="ide-err-stack">' + stack + '</pre>' : '')
  );
}

function _ideEscapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Called from sendIdeChatMessage just before ideSendToAgent. Returns a
// prefix block describing every buffered error and clears the buffer so the
// model only sees each error once. Empty string when there's nothing to say.
function ideDrainErrorsForAgent() {
  if (_ideErrorBuffer.size === 0) return '';
  const lines = [];
  for (const e of _ideErrorBuffer.values()) {
    const where = e.source + (e.line ? (':' + e.line + (e.col ? ':' + e.col : '')) : '');
    const tag = e.kind === 'rejection' ? 'UnhandledRejection'
              : e.kind === 'console' ? 'console.error'
              : 'Error';
    const mult = e.count > 1 ? ' (×' + e.count + ')' : '';
    lines.push('- [' + tag + mult + '] ' + e.message + ' at ' + where);
  }
  _ideErrorBuffer.clear();
  return '[Runtime errors observed in the preview since your last turn:]\n' +
         lines.join('\n') +
         '\n\n[User message:] ';
}

// Iframe-side script. Mirrors picker pattern: stringified IIFE, idempotent
// via a flag, postMessage to parent. Keeps the original console.error wired
// up so devtools still shows everything; we just observe.
function _ideErrorPipeSource() {
  return '(' + function() {
    if (window.__laxErrorPipe) return;
    window.__laxErrorPipe = true;

    function post(payload) {
      try { window.parent.postMessage(payload, '*'); } catch {}
    }

    // Capture phase so resource-load failures (<img>, <script>, <link>) fire
    // here — they don't bubble up to window. Branch on event target type to
    // separate the two paths: ScriptError vs resource 404.
    window.addEventListener('error', function(ev) {
      var tgt = ev && ev.target;
      if (tgt && tgt !== window && tgt instanceof HTMLElement) {
        var url = tgt.src || tgt.href || '';
        post({
          type: 'lax-ide-runtime-error',
          kind: 'resource',
          message: 'Failed to load resource: ' + (url || tgt.tagName),
          stack: '',
          source: String(url || tgt.tagName),
          line: 0, col: 0,
          ts: Date.now()
        });
        return;
      }
      var err = ev && ev.error;
      var msg = (ev && ev.message) || (err && err.message) || 'Unknown error';
      post({
        type: 'lax-ide-runtime-error',
        kind: 'error',
        message: String(msg),
        stack: err && err.stack ? String(err.stack) : '',
        source: ev && ev.filename ? String(ev.filename) : '',
        line: ev && typeof ev.lineno === 'number' ? ev.lineno : 0,
        col: ev && typeof ev.colno === 'number' ? ev.colno : 0,
        ts: Date.now()
      });
    }, true);

    // CSP refusals don't fire 'error' on window — securitypolicyviolation is
    // the only signal. #1 silent-failure mode for weaker models reaching for
    // a CDN script — they get a blank screen with no JS error.
    document.addEventListener('securitypolicyviolation', function(ev) {
      post({
        type: 'lax-ide-runtime-error',
        kind: 'csp',
        message: 'Refused: ' + (ev.blockedURI || '') + ' (' + (ev.violatedDirective || '') + ')',
        stack: '',
        source: ev.documentURI || '',
        line: ev.lineNumber || 0,
        col: ev.columnNumber || 0,
        ts: Date.now()
      });
    });

    // Blank-page heuristic — catches fully-broken layouts that don't throw
    // (e.g. CSS-only catastrophe, body never populated). Runs once after
    // DOMContentLoaded + a 500ms paint window so dynamic content has a chance
    // to land before we declare the page empty.
    function blankCheck() {
      try {
        var body = document.body;
        if (!body) return;
        var text = (body.innerText || '').trim();
        var media = document.querySelectorAll('img,video,canvas,svg').length;
        if (text.length < 50 && media === 0) {
          post({
            type: 'lax-ide-runtime-error',
            kind: 'blank',
            message: 'Preview rendered no visible content (body text < 50 chars, no media elements)',
            stack: '',
            source: '', line: 0, col: 0,
            ts: Date.now()
          });
        }
      } catch {}
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() { setTimeout(blankCheck, 500); });
    } else {
      setTimeout(blankCheck, 500);
    }

    window.addEventListener('unhandledrejection', function(ev) {
      var reason = ev && ev.reason;
      var msg = reason && reason.message ? reason.message
              : (typeof reason === 'string' ? reason : 'Unhandled promise rejection');
      post({
        type: 'lax-ide-runtime-error',
        kind: 'rejection',
        message: String(msg),
        stack: reason && reason.stack ? String(reason.stack) : '',
        source: '', line: 0, col: 0,
        ts: Date.now()
      });
    });

    var origErr = console.error;
    console.error = function() {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          if (a instanceof Error) parts.push(a.message);
          else if (a && typeof a === 'object') {
            try { parts.push(JSON.stringify(a)); } catch { parts.push(String(a)); }
          } else parts.push(String(a));
        }
        var first = arguments[0];
        var stack = (first instanceof Error && first.stack) ? String(first.stack) : '';
        post({
          type: 'lax-ide-runtime-error',
          kind: 'console',
          message: parts.join(' '),
          stack: stack,
          source: '', line: 0, col: 0,
          ts: Date.now()
        });
      } catch {}
      try { return origErr.apply(console, arguments); } catch {}
    };
  }.toString() + ')();';
}

window.ideDrainErrorsForAgent = ideDrainErrorsForAgent;
window._ideOnPreviewLoadErrors = _ideOnPreviewLoadErrors;
