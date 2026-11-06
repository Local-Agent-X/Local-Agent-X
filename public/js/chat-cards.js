// ── Chat: the cards a reply showed ──
//
// Under a reply whose agent called show_card (src/tools/show-card.ts): a strip of
// cards, each an image, a title, a few short facts and links, side by side and
// scrolling sideways when there are more than fit. A link opens its page in the
// browser; nothing on a card does more than that.
//
// Data: each show_card tool_end's metadata.card, which the live event and the
// reloaded row both carry (a spoken turn saves its show_card rows too), so the strip
// is a pure function of the turn's tool events and repaints identically. The phone
// draws the same card from the same data (agentxos card.ts).
//
// External deps (resolved at call time): esc (shared.js), AUTH_TOKEN (the /images/
// route wants ?token=, as chat-tool-cards.js's media previews do).

// The cards a turn showed, in the order shown.
function cardsOf(toolEvents) {
  const out = [];
  for (const t of toolEvents || []) {
    const card = t && t.type === 'end' && t.metadata && t.metadata.card;
    if (card && typeof card.title === 'string' && card.title) out.push(card);
  }
  return out;
}

function _cardImageSrc(path) {
  if (typeof path !== 'string' || !path.startsWith('/images/') || path.includes('..')) return '';
  const tok = (typeof AUTH_TOKEN === 'string' && AUTH_TOKEN) ? '?token=' + encodeURIComponent(AUTH_TOKEN) : '';
  return path + tok;
}

function _cardLinkHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

function _renderCard(card) {
  const el = document.createElement('div');
  el.className = 'chat-card';
  const src = _cardImageSrc(card.image);
  const facts = (card.facts || []).slice(0, 4).map((f) =>
    `<div class="chat-card-fact"><span>${esc(f.label)}</span><span>${esc(f.value)}</span></div>`).join('');
  const links = (card.links || []).slice(0, 3).map((l) => {
    const href = _cardLinkHref(l.url);
    return href ? `<a class="chat-card-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>` : '';
  }).join('');
  el.innerHTML =
    (src ? `<div class="chat-card-image"><img src="${esc(src)}" alt="${esc(card.title)}" loading="lazy"></div>` : '') +
    '<div class="chat-card-body">' +
    `<div class="chat-card-title">${esc(card.title)}</div>` +
    (card.subtitle ? `<div class="chat-card-subtitle">${esc(card.subtitle)}</div>` : '') +
    (facts ? `<div class="chat-card-facts">${facts}</div>` : '') +
    (links ? `<div class="chat-card-links">${links}</div>` : '') +
    (card.source ? `<div class="chat-card-source">${esc(card.source)}</div>` : '') +
    '</div>';
  // An image that will not load (deleted, offline) leaves the card without it.
  const img = el.querySelector('img');
  if (img) img.addEventListener('error', () => { const box = img.parentElement; if (box) box.remove(); });
  return el;
}

// The strip of a turn's cards.
function renderChatCards(cards) {
  const strip = document.createElement('div');
  strip.className = 'chat-cards';
  for (const card of cards) strip.appendChild(_renderCard(card));
  return strip;
}
