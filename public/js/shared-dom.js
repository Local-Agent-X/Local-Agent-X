// Global click handler for file download links
document.addEventListener('click', (e) => {
  const link = e.target.closest?.('.file-download');
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute('href');
  if (href) openFileLink(href);
});

// Opens a /files/ link the user clicked: the one way the shell opens a
// workspace file (chat links, the artifacts list).
function openFileLink(href) {
  // Text/doc formats the server serves inline (md/txt/json/pdf/images/…) open
  // in-app via the /files/ URL. Only true binaries (Office formats) go to the
  // desktop opener, which hands them to their native app. Without this split,
  // Electron sent every link to the OS default app — e.g. macOS opening a .md
  // README in Xcode.
  // linkPath (shared-md.js) is the parse md() names program links from, so
  // the file this opens is the one the link's label names.
  const path = linkPath(href);
  const ext = (path.split('.').pop() || '').toLowerCase();
  const inlineable = ['md', 'markdown', 'txt', 'json', 'csv', 'pdf', 'html', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  const isElectron = window.desktop?.isDesktop;

  if (isElectron && window.desktop?.openFile && !inlineable.includes(ext)) {
    if (path.startsWith('/files/')) window.desktop.openFile('workspace/' + path.slice('/files/'.length));
  } else if (isElectron && window.desktop.browser?.newTab) {
    // A file a browser shows opens in the in-app browser, beside the chat and
    // where the agent looks at it too, not in a separate window that hides
    // behind this one (2026-10-23).
    openInAppBrowser(new URL(agentFilesHref(href), location.origin).href);
  } else {
    // Browser, or an inlineable file in Electron: open the /files/ URL so the
    // content renders instead of launching an external editor. The opened page
    // is agent-written HTML: with an opener it could reach this window, which
    // holds the operator token and, in the desktop app, window.desktop.
    window.open(agentFilesHref(href), '_blank', 'noopener,noreferrer');
  }
}

// ── Local-service links → in-app browser ──
// Chat links to loopback URLs on a port other than LAX's own (a ComfyUI the
// agent started on :8188, a dev server it stood up, a local model UI) used to
// die silently in the desktop shell: the window-open handler classifies them
// as neither external (hostname is loopback, so no system browser) nor ours
// (different port, so no /files//apps handling) and denies them — the click
// did nothing. Route them into the in-app browser instead: mint a user tab
// through the canonical desktop.browser.newTab seam and surface the BROWSER
// panel. In a plain browser tab (no desktop bridge) target=_blank already
// works, so this handler stands down there.
function isLocalServiceLink(href, appOrigin) {
  let url;
  try { url = new URL(href, appOrigin); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const h = url.hostname;
  const loopback = h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  return loopback && url.origin !== new URL(appOrigin).origin;
}
window.isLocalServiceLink = isLocalServiceLink;

// A page LAX serves of what the agent made: an app, a dashboard or a workspace
// file on this origin (the server hands each to the agent origin), or the agent
// origin itself. Opened in the in-app browser like a local service, so the user
// sees it where the agent does; a /files link carries its capability.
function laxPageUrl(href, appOrigin) {
  let url;
  try { url = new URL(href, appOrigin); } catch { return null; }
  const agentOrigin = typeof laxAgent !== 'undefined' ? laxAgent.origin : '';
  if (agentOrigin && url.origin === agentOrigin) return url.href;
  if (url.origin !== new URL(appOrigin).origin || !/^\/(apps|dashboards|files)\//.test(url.pathname)) return null;
  return url.pathname.startsWith('/files/') ? new URL(agentFilesHref(url.pathname + url.search), appOrigin).href : url.href;
}

// A fresh USER tab in the in-app browser, with the BROWSER panel surfaced: the
// right rail opened if it's collapsed, then flipped to BROWSER (which pokes
// laxBrowserTab.onTabShown to attach the native view).
function openInAppBrowser(url) {
  window.desktop.browser.newTab(url);
  if (typeof agentFeedsOpen !== 'undefined' && !agentFeedsOpen && typeof toggleAgentFeeds === 'function') toggleAgentFeeds();
  if (typeof switchSidePanelTab === 'function') switchSidePanelTab('browser');
}

document.addEventListener('click', (e) => {
  if (e.defaultPrevented) return;
  const link = e.target.closest?.('a[href]');
  if (!link || link.classList.contains('file-download')) return;
  if (!window.desktop?.isDesktop || !window.desktop.browser?.newTab) return;
  const target = isLocalServiceLink(link.href, location.origin) ? link.href : laxPageUrl(link.href, location.origin);
  if (!target) return;
  e.preventDefault();
  openInAppBrowser(target);
});

// Apply syntax highlighting to code blocks (runs after md() output is inserted into DOM)
function highlightCodeBlocks(container) {
  if (typeof hljs === 'undefined') return;
  const el = container || document;
  el.querySelectorAll('pre code[class*="language-"]').forEach(block => {
    if (!block.dataset.highlighted) { hljs.highlightElement(block); block.dataset.highlighted = 'true'; }
  });
}

// Render ```mermaid code blocks into diagrams (runs after md() output is in
// the DOM, same hook as highlightCodeBlocks). The block's TEXT is handed to
// mermaid.render (securityLevel 'strict' escapes labels — model output can't
// inject markup through the SVG), and the whole code-block wrapper is swapped
// for the diagram. mermaid.parse() gates rendering so a half-streamed block
// stays a plain code block until it parses; the next observer tick retries.
// Mermaid (2.7MB) is lazy-loaded on the first ```mermaid block instead of
// shipping in app.html's <head>, where its parse+eval blocked first paint on
// every boot. Injected as a same-origin script (CSP script-src 'self' allows
// it); resolves on error too — the typeof guard below just no-ops then, and
// the next observer tick retries the load.
let _mermaidLoad = null;
function _loadMermaid() {
  if (typeof mermaid !== 'undefined') return Promise.resolve();
  if (!_mermaidLoad) {
    _mermaidLoad = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/vendor/mermaid/mermaid.min.js';
      s.onload = resolve;
      s.onerror = () => { _mermaidLoad = null; resolve(); };
      document.head.appendChild(s);
    });
  }
  return _mermaidLoad;
}
let _mermaidReady = false;
function _mermaidInit() {
  if (_mermaidReady) return;
  // Match the app palette: dark UI → dark diagram theme.
  const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255];
  const dark = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 128;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' });
  _mermaidReady = true;
}
let _mermaidSeq = 0;
async function renderMermaidBlocks(container) {
  const el = container || document;
  const blocks = el.querySelectorAll('pre code.language-mermaid');
  if (!blocks.length) return;
  await _loadMermaid();
  if (typeof mermaid === 'undefined') return;
  for (const block of blocks) {
    if (block.dataset.mermaidDone) continue;
    block.dataset.mermaidDone = 'true';
    const src = block.textContent;
    try {
      _mermaidInit();
      if (!(await mermaid.parse(src, { suppressErrors: true }))) {
        // Incomplete/invalid (usually mid-stream): leave the code block and
        // allow a retry on the next repaint.
        delete block.dataset.mermaidDone;
        continue;
      }
      const { svg } = await mermaid.render('md-mermaid-' + (++_mermaidSeq), src);
      const wrapper = block.closest('.code-block-wrapper');
      if (!wrapper || !wrapper.parentNode) continue;
      const div = document.createElement('div');
      div.className = 'md-mermaid';
      div.innerHTML = svg;
      wrapper.replaceWith(div);
    } catch {
      // Renderer threw despite parse passing — keep the readable code block.
    }
  }
}

// Auto-highlight after any innerHTML update (debounced)
let _hlDebounce;
const _hlObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => {
  clearTimeout(_hlDebounce);
  _hlDebounce = setTimeout(() => { highlightCodeBlocks(); renderMermaidBlocks(); }, 100);
}) : null;
if (_hlObserver) {
  document.addEventListener('DOMContentLoaded', () => {
    const msgs = document.getElementById('messages');
    if (msgs) _hlObserver.observe(msgs, { childList: true, subtree: true });
  });
}

// Copy code block to clipboard (feature 91) — delegated, since sanitizeHtml()
// strips inline on*= handlers. Walks from button → wrapper → <pre>.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.code-copy-btn');
  if (!btn) return;
  const pre = btn.closest('.code-block-wrapper')?.querySelector('pre.code-block');
  if (!pre) return;
  const text = pre.textContent;
  const flash = (label) => {
    btn.textContent = label;
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      flash(ok ? 'Copied!' : 'Copy failed');
    } catch { flash('Copy failed'); }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => flash('Copied!'), fallback);
  } else {
    fallback();
  }
});
