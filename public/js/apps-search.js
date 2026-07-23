// ── Apps Gallery Search ──
// Client-side filter for the apps grid + custom pages list. Lives in its own
// file to keep apps.js under the 400-LOC hygiene gate. apps.js calls
// applyAppsSearchFilter() after every grid render so the filter survives the
// 5-second poll rebuilds.

let _appsSearchQuery = '';

function onAppsSearchInput(value) {
  _appsSearchQuery = (value || '').trim().toLowerCase();
  applyAppsSearchFilter();
}

function applyAppsSearchFilter() {
  const grid = document.getElementById('apps-grid');
  const box = document.getElementById('apps-search-box');
  const noMatch = document.getElementById('apps-search-empty');
  if (!grid || !box) return;

  const q = _appsSearchQuery;
  const cards = Array.from(grid.querySelectorAll('.app-card'));

  // Custom pages filter too — they render below the grid on the same page.
  const pagesSection = document.getElementById('custom-pages-section');
  const pagesList = document.getElementById('custom-pages-list');
  const pageCards = pagesList ? Array.from(pagesList.querySelectorAll('.app-card')) : [];

  // No apps at all → the "no apps yet" empty state owns the page; hide search.
  if (cards.length === 0 && pageCards.length === 0) {
    box.style.display = 'none';
    if (noMatch) noMatch.style.display = 'none';
    return;
  }
  box.style.display = '';

  let visible = 0;
  for (const card of cards) {
    const hay = card.getAttribute('data-search') || '';
    const show = !q || hay.includes(q);
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  }

  let pagesVisible = 0;
  for (const card of pageCards) {
    const hay = card.getAttribute('data-search') || '';
    const show = !q || hay.includes(q);
    card.style.display = show ? '' : 'none';
    if (show) pagesVisible++;
  }
  // Collapse the CUSTOM PAGES header when the filter hides every page in it.
  if (pagesSection && pageCards.length > 0) {
    pagesSection.style.display = pagesVisible ? '' : 'none';
  }

  if (noMatch) noMatch.style.display = (q && visible === 0 && pagesVisible === 0) ? '' : 'none';
}

window.onAppsSearchInput = onAppsSearchInput;
window.applyAppsSearchFilter = applyAppsSearchFilter;
