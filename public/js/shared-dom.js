// Global click handler for file download links
document.addEventListener('click', (e) => {
  const link = e.target.closest?.('.file-download');
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute('href');
  if (!href) return;

  // Text/doc formats the server serves inline (md/txt/json/pdf/images/…) open
  // in-app via the /files/ URL. Only true binaries (Office formats) go to the
  // desktop opener, which hands them to their native app. Without this split,
  // Electron sent every link to the OS default app — e.g. macOS opening a .md
  // README in Xcode.
  const ext = (href.split('?')[0].split('.').pop() || '').toLowerCase();
  const inlineable = ['md', 'markdown', 'txt', 'json', 'csv', 'pdf', 'html', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  const isElectron = window.desktop?.isDesktop;

  if (isElectron && window.desktop?.openFile && !inlineable.includes(ext)) {
    const filename = href.split('/files/')[1]?.split('?')[0];
    if (filename) window.desktop.openFile('workspace/' + decodeURIComponent(filename));
  } else {
    // Browser, or an inlineable file in Electron: open the /files/ URL so the
    // content renders instead of launching an external editor.
    window.open(href, '_blank');
  }
});

// Apply syntax highlighting to code blocks (runs after md() output is inserted into DOM)
function highlightCodeBlocks(container) {
  if (typeof hljs === 'undefined') return;
  const el = container || document;
  el.querySelectorAll('pre code[class*="language-"]').forEach(block => {
    if (!block.dataset.highlighted) { hljs.highlightElement(block); block.dataset.highlighted = 'true'; }
  });
}

// Auto-highlight after any innerHTML update (debounced)
let _hlDebounce;
const _hlObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => {
  clearTimeout(_hlDebounce);
  _hlDebounce = setTimeout(() => highlightCodeBlocks(), 100);
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
