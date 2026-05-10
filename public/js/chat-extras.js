// ── Chat: Search + Smart Context + Mood ──
//
// Three small chat-page features previously living at the tail of chat.js:
//   1. Global cross-session search (Ctrl+Shift+F)
//   2. Smart context indicator pill (CTX +N near the input)
//   3. Mood/tone detection indicator (post-message classifier ping)
//
// Each is small + independent, so they share one file rather than each
// owning a 30-LOC module. Extracted from chat.js as part of the 400-LOC
// god-file split.
//
// External deps from chat.js / shared.js:
//   - apiFetch, esc           (shared.js)
//   - Spring                  (spring.js)
//   - selectChat, closeForkTree (chat.js / app.js — auto-window function decls)

// ═══════════════════════════════════════════════
// Feature 3: Cross-Session Search
// ═══════════════════════════════════════════════

let _gsTimer = null;
function openGlobalSearch() {
  const overlay = document.getElementById('global-search-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  // Spring entrance for the search dialog
  var dialog = overlay.querySelector('div');
  if (dialog && typeof Spring !== 'undefined') {
    Spring.fadeIn(dialog, { preset: 'stiff', scale: true, scaleFrom: 0.94 });
  }
  const input = document.getElementById('global-search-input');
  if (input) { input.value = ''; input.focus(); }
  document.getElementById('global-search-results').innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.78rem">Type to search across all conversations</div>';
  overlay.onclick = (e) => { if (e.target === overlay) closeGlobalSearch(); };
}

function closeGlobalSearch() {
  const overlay = document.getElementById('global-search-overlay');
  if (!overlay) return;
  var dialog = overlay.querySelector('div');
  if (dialog && typeof Spring !== 'undefined') {
    Spring.fadeOut(dialog, { preset: 'stiff', scale: true, scaleTo: 0.94, onDone: function() { overlay.style.display = 'none'; } });
  } else {
    overlay.style.display = 'none';
  }
}

function debounceGlobalSearch(query) {
  if (_gsTimer) clearTimeout(_gsTimer);
  _gsTimer = setTimeout(() => runGlobalSearch(query), 300);
}

async function runGlobalSearch(query) {
  const resultsEl = document.getElementById('global-search-results');
  if (!resultsEl) return;
  if (!query || query.length < 2) {
    resultsEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.78rem">Type at least 2 characters</div>';
    return;
  }
  resultsEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.78rem;font-family:var(--mono)">Searching...</div>';

  try {
    const res = await apiFetch(`/api/sessions/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!data.results || data.results.length === 0) {
      resultsEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.78rem">No results found</div>';
      return;
    }

    resultsEl.innerHTML = data.results.map(r => {
      const matchHtml = r.matches.map(m => {
        const highlighted = esc(m.snippet).replace(new RegExp(esc(query), 'gi'), match => `<mark>${match}</mark>`);
        return `<div class="gs-result-match"><span style="color:var(--muted);font-size:.6rem">${m.role}:</span> ${highlighted}</div>`;
      }).join('');
      return `<div class="gs-result" onclick="closeGlobalSearch();selectChat('${esc(r.sessionId)}')">
        <div class="gs-result-title">${esc(r.title)}</div>
        ${matchHtml}
        <div class="gs-result-meta">${r.matches.length} match${r.matches.length > 1 ? 'es' : ''}</div>
      </div>`;
    }).join('');
  } catch (e) {
    resultsEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger);font-size:.78rem">Search error: ${esc(e.message)}</div>`;
  }
}

// Keyboard shortcut: Ctrl+Shift+F for global search
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    openGlobalSearch();
  }
  if (e.key === 'Escape') {
    closeGlobalSearch();
    closeForkTree();
  }
});

// ═══════════════════════════════════════════════
// Feature 4: Smart Context Indicator
// ═══════════════════════════════════════════════

function updateSmartContextIndicator(contextData) {
  const el = document.getElementById('smart-ctx-indicator');
  if (!el) return;
  if (contextData && contextData.hasSmartContext) {
    el.style.display = 'inline-block';
    el.title = `Smart context: ${contextData.sources || 0} related sessions injected`;
    el.textContent = `CTX +${contextData.sources || 0}`;
  } else {
    el.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════
// Feature 5: Mood/Tone Detection
// ═══════════════════════════════════════════════

async function detectMood(text) {
  const el = document.getElementById('mood-indicator');
  if (!el) return;
  try {
    const res = await apiFetch('/api/mood/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (data.mood && data.mood !== 'neutral') {
      el.style.display = 'inline-block';
      el.className = data.mood;
      el.id = 'mood-indicator';
      const icons = { positive: '&#9786;', negative: '&#9785;', urgent: '&#9888;' };
      el.innerHTML = `${icons[data.mood] || ''} ${esc(data.mood)}${data.tone !== 'balanced' ? ' &middot; ' + esc(data.tone) : ''}`;
      el.title = data.styleHint || `Detected mood: ${data.mood}`;
      // Auto-hide after 30 seconds
      setTimeout(() => { el.style.display = 'none'; }, 30000);
    } else {
      el.style.display = 'none';
    }
  } catch {
    el.style.display = 'none';
  }
}
