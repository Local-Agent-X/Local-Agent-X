// The Core node — the agent's identity as an ID card in the top row of the
// Memory tab. Click it and the full "dossier" expands to a full-page overlay.
// Live view of /api/memory/identity, which reads IDENTITY/HEART/USER; naming
// the agent or editing those files reshapes the card on the next open. Built
// with textContent throughout — identity/profile fields are user/agent-authored
// and rendered as text, never HTML.

let built = false;
let overlayEl = null;

export async function ensureCoreNode() {
  const slot = document.getElementById('mem-core-card');
  if (!slot || built) return;
  built = true;

  const p = (await loadProfile()) || defaultProfile();
  slot.append(buildCard(p));

  const important = await loadImportant();
  overlayEl = buildDossier(p, important);
  document.body.append(overlayEl);

  slot.firstChild.addEventListener('click', openDossier);
}

async function loadProfile() {
  try { return await window.apiJson('/api/memory/identity'); }
  catch { return null; }
}

async function loadImportant() {
  try { return (await window.apiJson('/api/memory/important?limit=8')).items || []; }
  catch { return []; }
}

function defaultProfile() {
  return {
    named: false,
    identity: { name: '', emoji: '', tagline: '', vibe: '', portrait: '/agent-x-portrait.png' },
    heart: { orders: [], boundaries: [] },
    user: { fields: [] },
    network: { associates: [], total: 0 },
    memories: 0,
    lastAmended: null,
    contradictions: 0,
  };
}

function openDossier() { overlayEl.classList.add('open'); }
function closeDossier() { overlayEl.classList.remove('open'); }

function codename(p) { return p.named ? p.identity.name : 'AGENT X'; }
function taglineText(p) { return p.identity.tagline || (p.named ? '' : 'identity pending…'); }

function buildCard(p) {
  const card = el('div', 'mb-core-card mb-core-bannercard');
  card.append(banner());

  const head = el('div', 'mb-core-bhead');
  const pf = el('div', 'mb-core-pf');
  pf.append(portraitImg(p));
  const who = el('div', 'mb-core-bwho');
  who.append(
    textEl('div', 'mb-core-role', 'PERSONNEL FILE · #AX-001'),
    textEl('h2', null, codename(p)),
  );
  head.append(pf, who, textEl('span', 'mb-core-open', 'OPEN FILE ▸'));
  card.append(head);

  const chips = el('div', 'mb-core-bchips');
  chips.append(
    chip('live', '● LOADED IN ACTIVE SESSION'),
    chip('grade', '◇ GRADE A1 · SELF-DECLARED'),
    chip('lock', '🔒 EXEMPT FROM DECAY'),
  );
  card.append(chips);
  return card;
}

function buildDossier(p, important) {
  const overlay = el('div', 'mb-dossier-overlay');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDossier(); });

  const d = el('aside', 'mb-dossier');
  d.append(banner());

  const head = el('div', 'mb-dossier-head');
  const pf = el('div', 'mb-core-pf');
  pf.append(portraitImg(p));
  const idbox = el('div');
  idbox.append(
    textEl('div', 'mb-core-role', 'PERSONNEL FILE · #AX-001'),
    textEl('h1', 'mb-dossier-name', codename(p)),
    textEl('div', 'mb-core-tag', taglineText(p) ? '“' + taglineText(p) + '”' : ''),
  );
  const close = textEl('button', 'mb-dossier-x', '✕');
  close.addEventListener('click', closeDossier);
  head.append(pf, idbox, close);
  d.append(head);

  const chips = el('div', 'mb-dossier-chips');
  chips.append(
    chip('live', '● LOADED IN ACTIVE SESSION'),
    chip('grade', '◇ GRADE A1 · SELF-DECLARED'),
    chip('lock', '🔒 EXEMPT FROM DECAY'),
  );
  d.append(chips);

  // Pinned header above (banner + identity + chips) and footer below; only this
  // body scrolls, so the frame stays put.
  const body = el('div', 'mb-dossier-body');

  const isDefaultPortrait = p.identity.portrait === '/agent-x-portrait.png';
  body.append(section('§1', 'COVER IDENTITY', 'IDENTITY.md', grid([
    ['Codename', p.named ? p.identity.name : '— not yet named —'],
    ['Portrait', isDefaultPortrait ? 'stock (default)' : 'custom'],
    ['Tagline', p.identity.tagline || '—'],
    ['Vibe', p.identity.vibe || '—'],
  ])));

  const orders = sectionBody('§2', 'STANDING ORDERS', 'HEART.md');
  let n = 1;
  for (const o of p.heart.orders) orders.append(order(false, 'ORD·' + pad(n++), o));
  let r = 1;
  for (const b of p.heart.boundaries) orders.append(order(true, 'RESTR·' + pad(r++), b));
  if (!p.heart.orders.length && !p.heart.boundaries.length) {
    orders.append(textEl('div', 'mb-dossier-empty', 'No standing orders set yet.'));
  }
  body.append(orders.section);

  if (p.user.fields.length) {
    body.append(section('§3', 'THE HANDLER', 'USER.md',
      grid(p.user.fields.map((f) => [f.label, f.value]))));
  }

  const net = p.network || { associates: [], total: 0 };
  if (net.associates.length) {
    const sec = sectionBody('§4', 'KNOWN ASSOCIATES', '→ THE NETWORK');
    const wrap = el('div', 'mb-net');
    for (const a of net.associates) {
      const c = el('span', 'mb-net-chip');
      c.append(textEl('span', 'mb-net-av', (a.name[0] || '?').toUpperCase()), textEl('span', null, a.name));
      if (a.mentions) c.append(textEl('span', 'mb-net-n', '· ' + a.mentions));
      wrap.append(c);
    }
    const more = net.total - net.associates.length;
    if (more > 0) {
      const m = el('span', 'mb-net-chip mb-net-more');
      m.append(textEl('span', 'mb-net-av', '+'), textEl('span', null, more + ' more in The Network'));
      wrap.append(m);
    }
    sec.append(wrap);
    body.append(sec.section);
  }

  if (important && important.length) {
    const sec = sectionBody('§5', 'PRIORITY INTEL', '→ IMPORTANCE RANK');
    for (const it of important) sec.append(memoryRow(it));
    body.append(sec.section);
  }

  d.append(body);
  d.append(buildFooter(p));
  d.append(banner());
  overlay.append(d);
  return overlay;
}

function buildFooter(p) {
  const foot = el('div', 'mb-dossier-foot');
  const bits = [];
  if (p.lastAmended) bits.push('LAST AMENDED ' + fmtDate(p.lastAmended));
  if (typeof p.memories === 'number') bits.push(p.memories.toLocaleString() + ' MEMORIES');
  bits.push('CONTRADICTIONS: ' + (p.contradictions || 0));
  foot.textContent = bits.join('  ·  ');
  return foot;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '·' + pad(d.getMonth() + 1) + '·' + pad(d.getDate());
}

// ── builders ──

function portraitImg(p) {
  const img = el('img');
  img.src = p.identity.portrait || '/agent-x-portrait.png';
  img.alt = 'Agent portrait';
  return img;
}

function section(num, title, file, bodyNode) {
  const { section, body } = sectionShell(num, title, file);
  body.append(bodyNode);
  return section;
}

function sectionBody(num, title, file) {
  const { section, body } = sectionShell(num, title, file);
  return { section, append: (...n) => body.append(...n) };
}

function sectionShell(num, title, file) {
  const s = el('section', 'mb-dossier-sec');
  const head = el('div', 'mb-dossier-sh');
  head.append(textEl('span', 'mb-dossier-num', num), document.createTextNode(' ' + title + ' '),
    el('span', 'mb-dossier-line'), textEl('span', 'mb-dossier-file', file));
  const body = el('div');
  s.append(head, body);
  return { section: s, body };
}

function grid(pairs) {
  const g = el('div', 'mb-dossier-grid');
  for (const [label, value] of pairs) {
    const f = el('div', 'mb-dossier-field');
    f.append(textEl('div', 'mb-df-l', label), textEl('div', 'mb-df-v', value));
    g.append(f);
  }
  return g;
}

function order(isBoundary, code, text) {
  const o = el('div', 'mb-dossier-order' + (isBoundary ? ' boundary' : ''));
  o.append(textEl('span', 'mb-do-c', code), textEl('span', null, text));
  return o;
}

function memoryRow(item) {
  const row = el('div', 'mb-dossier-mem mb-mem-' + (item.level || 'low'));
  row.append(
    textEl('span', 'mb-mem-score', String(item.score)),
    textEl('span', 'mb-mem-lvl', (item.level || '').toUpperCase()),
    textEl('span', 'mb-mem-text', item.content || ''),
  );
  return row;
}

function chip(kind, text) { return textEl('span', 'mb-dossier-chip ' + kind, text); }
function banner() { return textEl('div', 'mb-dossier-banner', 'TOP SECRET // EYES ONLY // CENTRAL REGISTRY'); }
function pad(n) { return String(n).padStart(2, '0'); }

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function textEl(tag, cls, text) {
  const e = el(tag, cls);
  e.textContent = text;
  return e;
}
