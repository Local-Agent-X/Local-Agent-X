// ── Settings: Settings Search ──
//
// In-page search across the settings tabs — filters .field elements by
// label/id substring match. Tiny, but here for completeness.

// ── Settings Search ──

function searchSettings(query) {
  const q = query.toLowerCase().trim();
  const cards = document.querySelectorAll('.settings-content .section-card');
  const tabs = document.querySelectorAll('.tab-pane');
  if (!q) {
    // Show all, restore tab state
    cards.forEach(c => c.style.display = '');
    tabs.forEach(t => t.style.display = '');
    return;
  }
  // Show all tabs, filter cards by text content
  tabs.forEach(t => t.style.display = '');
  cards.forEach(c => {
    const text = c.textContent.toLowerCase();
    c.style.display = text.includes(q) ? '' : 'none';
  });
}

// Simple mode removed — all features visible to all users

