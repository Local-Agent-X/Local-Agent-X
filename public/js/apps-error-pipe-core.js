// ── App runtime-error capture core ──
// The ONE source of the error-pipe capture logic, consumed two ways:
//   1. Desktop IDE: app.html loads this file, apps-ide-errors.js stringifies
//      __laxInstallErrorPipe into the preview iframe with a postMessage emitter.
//   2. Phone over the broker: the server reads this file's raw text and injects
//      it into tunneled app HTML with a fetch-POST emitter (error-pipe-inject.ts).
// Keep this file to comments + the single top-level function — the server
// injects the whole file body verbatim inside a script tag, so a literal
// closing-script-tag sequence ANYWHERE here (even a comment) would truncate
// the injected block. error-pipe-inject.test.ts guards this.

function __laxInstallErrorPipe(post) {
  if (window.__laxErrorPipe) return;
  window.__laxErrorPipe = true;

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
}
