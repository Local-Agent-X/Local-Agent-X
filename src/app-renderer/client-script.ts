/**
 * Client-side IIFE injected into the rendered app page. Handles event dispatch
 * back to the server, tab switching, state polling, data-bind application,
 * and action-queue execution with DOM-safe sanitization.
 *
 * Only appId and apiBase are interpolated (both JSON-stringified). The rest is
 * a static string so the nonce-protected CSP can apply.
 */

export function renderClientScript(appId: string, apiBase: string): string {
  return `
(function() {
  'use strict';

  var APP_ID = ${JSON.stringify(appId)};
  var API = ${JSON.stringify(apiBase)};
  var AUTH = localStorage.getItem('sax_token') || '';
  var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH };

  // ── Event dispatch to server ──
  window.appEvent = function(type, componentId, data) {
    fetch(API + '/api/apps/' + APP_ID + '/events', {
      method: 'POST', headers: headers,
      body: JSON.stringify({ type: type, sourceComponent: componentId, data: data })
    }).catch(function() {});
  };

  // ── Tab switching ──
  window.switchTab = function(btn, idx) {
    btn.parentElement.querySelectorAll('.app-tab-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    btn.closest('.app-tabs').querySelectorAll('.app-tab-panel').forEach(function(p, i) {
      p.classList.toggle('active', i === idx);
    });
  };

  // ── State polling ──
  function pollState() {
    fetch(API + '/api/apps/' + APP_ID + '/state', { headers: { Authorization: 'Bearer ' + AUTH } })
      .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(state) {
        var status = document.getElementById('app-status');
        if (status) { status.innerHTML = '<span class="app-status-dot"></span> Connected'; status.className = 'app-status connected'; }

        // Apply component values
        var values = state.componentValues || {};
        for (var compId in values) {
          if (!values.hasOwnProperty(compId)) continue;
          var val = values[compId];
          var el = document.getElementById(compId);
          if (!el) continue;

          if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
            if (el.type === 'checkbox') el.checked = !!val;
            else el.value = String(val);
          } else {
            var bound = el.querySelector('[data-bind]');
            if (bound) {
              var bind = bound.getAttribute('data-bind');
              if (bind === 'value') {
                if (bound.classList.contains('app-progress-fill')) {
                  bound.style.width = Math.min(100, Math.max(0, Number(val))) + '%';
                } else {
                  bound.textContent = String(val);
                }
              } else if (bind === 'rows' && Array.isArray(val)) {
                bound.innerHTML = val.map(function(row) {
                  return '<tr>' + (Array.isArray(row) ? row : []).map(function(c) { return '<td>' + escapeForDom(c) + '</td>'; }).join('') + '</tr>';
                }).join('');
              } else if (bind === 'items' && Array.isArray(val)) {
                bound.innerHTML = val.map(function(i) { return '<li>' + escapeForDom(i) + '</li>'; }).join('');
              } else if (bind === 'text') {
                bound.textContent = String(val);
              }
            } else {
              el.textContent = String(val);
            }
          }
        }

        // Process action queue
        var pending = (state.actionQueue || []).filter(function(a) { return !a.consumed; });
        var consumed = [];
        pending.forEach(function(act) {
          var el = act.target ? document.getElementById(act.target) : null;
          switch (act.action) {
            case 'click': if (el) el.click(); break;
            case 'fill': if (el) { el.value = String(act.value || ''); el.dispatchEvent(new Event('input')); } break;
            case 'focus': if (el) el.focus(); break;
            case 'scroll': if (el) el.scrollIntoView({ behavior: 'smooth' }); break;
            case 'addClass': if (el && act.value) el.classList.add(String(act.value)); break;
            case 'removeClass': if (el && act.value) el.classList.remove(String(act.value)); break;
            case 'setHtml': if (el) el.innerHTML = sanitizeDom(String(act.value || '')); break;
            case 'refresh': window.location.reload(); break;
          }
          consumed.push(act.id);
        });
        if (consumed.length > 0) {
          fetch(API + '/api/apps/' + APP_ID + '/actions/consume', {
            method: 'POST', headers: headers,
            body: JSON.stringify({ actionIds: consumed })
          }).catch(function() {});
        }
      })
      .catch(function() {
        var status = document.getElementById('app-status');
        if (status) { status.innerHTML = '<span class="app-status-dot"></span> Disconnected'; status.className = 'app-status'; }
      });
  }

  // DOM-safe escape for dynamic content insertion
  function escapeForDom(s) {
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // Robust sanitize for setHtml actions — builds regexes from strings
  // to avoid embedding literal HTML tag patterns in the page source
  function sanitizeDom(html) {
    function stripTag(r, t, sc) {
      if (sc) return r.replace(new RegExp('<' + t + '\\\\b[^>]*/?>','gi'), '');
      return r.replace(new RegExp('<' + t + '\\\\b[^>]*>[\\\\s\\\\S]*?</' + t + '>','gi'), '');
    }
    var result = html.replace(/\\x00/g, '');
    var paired = ['scr'+'ipt','iframe','object','applet','style','svg','math','form','textarea','template'];
    var solo = ['embed','link','base','meta'];
    for (var i = 0; i < paired.length; i++) result = stripTag(result, paired[i], false);
    for (var j = 0; j < solo.length; j++) result = stripTag(result, solo[j], true);
    result = result.replace(/\\bon\\w+\\s*=/gi, 'data-blocked-handler=');
    result = result.replace(/\\bhref\\s*=\\s*["']?\\s*javascript:/gi, 'href="blocked:');
    result = result.replace(/\\bhref\\s*=\\s*["']?\\s*data:/gi, 'href="blocked:');
    result = result.replace(/\\bsrc\\s*=\\s*["']?\\s*javascript:/gi, 'src="blocked:');
    result = result.replace(/\\bsrc\\s*=\\s*["']?\\s*data:/gi, 'src="blocked:');
    result = result.replace(/\\bstyle\\s*=\\s*["'][^"']*expression\\s*\\(/gi, 'style="');
    result = result.replace(/\\bstyle\\s*=\\s*["'][^"']*url\\s*\\(/gi, 'style="');
    return result;
  }

  // Poll every 2 seconds
  setInterval(pollState, 2000);
  pollState();
})();
`;
}
