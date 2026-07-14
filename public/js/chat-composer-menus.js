// ── Chat: composer popovers (cascading model menu + voice settings) ──
//
// The in-box model chip opens a cascading menu: providers column → models
// column for the hovered/clicked provider → a thinking-effort flyout beside
// the hovered model. Clicking a model switches provider+model (keeping the
// current effort); clicking an effort in the flyout switches all three in
// one go. The speaker icon opens a small popover holding the voice picker +
// speech-speed slider (their <select>/<input> keep the same element ids the
// voice modals look up).
//
// Both popovers live OUTSIDE the innerHTML-rebuilt #composer-chips span, so
// the 10s status-bar re-render can't destroy an open menu. While the model
// menu is open, window._laxModelMenuOpen tells updateStatusBar to skip chip
// rebuilds entirely (this menu renders itself from _providersCache anyway).
//
// External deps (classic-script globals):
//   - esc                                  (shared.js)
//   - _providersCache, loadProviders, classifyModelTier, laxSwitchModel,
//     LAX_EFFORT_LEVELS, laxGetSavedEffort, updateStatusBar
//                                          (chat-status-bar.js)

window._laxModelMenuOpen = false;

function _mmEl() { return document.getElementById('model-menu'); }
function _vpEl() { return document.getElementById('voice-pop'); }

function closeModelMenu() {
  const menu = _mmEl();
  if (menu) { menu.style.display = 'none'; menu.innerHTML = ''; }
  window._laxModelMenuOpen = false;
  document.getElementById('model-chip')?.classList.remove('open');
}

function closeVoicePop() {
  const pop = _vpEl();
  if (pop) pop.style.display = 'none';
}

function toggleModelMenu(ev) {
  if (ev) ev.stopPropagation();
  const menu = _mmEl();
  if (!menu) return;
  if (window._laxModelMenuOpen) { closeModelMenu(); return; }
  closeVoicePop();
  window._laxModelMenuOpen = true;
  document.getElementById('model-chip')?.classList.add('open');
  _mmRender();
  menu.style.display = 'block';
  _mmPositionMenu();
  // Cold boot: the provider cache may still be warming — refresh and
  // re-render in place so the menu fills in without being reopened.
  if (!_providersCache?.providers?.length) {
    loadProviders().then(() => { if (window._laxModelMenuOpen) _mmRender(); });
  }
}

function toggleVoicePop(ev) {
  if (ev) ev.stopPropagation();
  const pop = _vpEl();
  if (!pop) return;
  if (pop.style.display !== 'none') { closeVoicePop(); return; }
  closeModelMenu();
  // Rebuild the popover body while it's still closed (updateStatusBar only
  // writes #voice-pop when hidden), so it opens with fresh voice/tier data.
  try { updateStatusBar(true); } catch {}
  pop.style.display = 'block';
}

// The menu is a single providers column. Hovering a provider pops a models
// flyout to its right; hovering a model pops a thinking-effort flyout further
// right. Flyouts are absolutely positioned siblings (not columns), so the
// providers column never re-renders on hover — nothing shifts under the
// cursor, so nothing bounces.
function _mmRender() {
  const menu = _mmEl();
  if (!menu) return;
  const data = _providersCache || {};
  const providers = data.providers || [];
  if (!providers.length) {
    menu.innerHTML = `<div class="mm-col"><div class="mm-head">Loading providers…</div></div>`;
    return;
  }
  const provRows = providers.map(p =>
    `<button class="mm-row${p.active ? ' active' : ''}" data-pid="${esc(p.id)}" role="menuitem" aria-haspopup="menu">
       ${esc(p.name)}<span class="mm-arrow">&#9654;</span></button>`).join('');

  menu.innerHTML = `<div class="mm-col mm-prov-col"><div class="mm-head">Provider</div>${provRows}</div>`;
  menu._openPid = null;

  for (const row of menu.querySelectorAll('.mm-row[data-pid]')) {
    const provider = providers.find(p => p.id === row.dataset.pid);
    const open = () => _mmShowModels(row, provider);
    row.addEventListener('mouseenter', open);
    row.addEventListener('click', open);
  }
}

// Remove the models flyout (and any effort flyout hanging off it).
function _mmHideModels() {
  const menu = _mmEl();
  if (!menu) return;
  menu.querySelectorAll('.mm-model-fly, .mm-effort').forEach(el => el.remove());
  menu._openPid = null;
}

function _mmShowModels(provRow, provider) {
  const menu = _mmEl();
  if (!menu || !provider) return;
  if (menu._openPid === provider.id) return;   // already showing this one
  _mmHideModels();
  menu._openPid = provider.id;

  // Highlight the provider whose models are open.
  menu.querySelectorAll('.mm-row[data-pid]').forEach(r =>
    r.classList.toggle('hl', r.dataset.pid === provider.id));

  const current = (_providersCache || {}).current || {};
  const models = Array.isArray(provider.models) ? provider.models : [];
  const modelRows = models.length ? models.map(m => {
    const tier = classifyModelTier(m);
    const isCurrent = provider.active && m === current.model;
    const tag = isCurrent ? `<span class="mm-tag mm-check">&#10003;</span>`
      : tier !== 'strong' ? `<span class="mm-tag">${tier}</span>` : `<span class="mm-tag"></span>`;
    return `<button class="mm-row${isCurrent ? ' active' : ''}" data-model="${esc(m)}" role="menuitem" aria-haspopup="menu">${esc(m)}${tag}</button>`;
  }).join('') : `<div class="mm-head">No models</div>`;

  const fly = document.createElement('div');
  fly.className = 'mm-fly mm-model-fly';
  fly.setAttribute('role', 'menu');
  fly.innerHTML = `<div class="mm-head">Model &#183; hover for thinking</div>${modelRows}`;
  for (const row of fly.querySelectorAll('.mm-row[data-model]')) {
    row.addEventListener('mouseenter', () => _mmShowEffort(row, fly, provider.id, row.dataset.model));
    row.addEventListener('click', () => {
      closeModelMenu();
      laxSwitchModel(provider.id, row.dataset.model);
    });
  }
  // Scrolling the model list would leave the effort flyout over the wrong
  // row — just hide it while scrolling.
  fly.addEventListener('scroll', _mmHideEffort);
  menu.appendChild(fly);
  _mmPositionFly(fly, provRow, menu.getBoundingClientRect().width - 4);
}

function _mmHideEffort() {
  _mmEl()?.querySelector('.mm-effort')?.remove();
}

// Align the menu's left edge with the model chip so it opens directly above
// the chip (the CSS default is left:0, which pins it to the composer's far
// left). Flyouts extend rightward from here into open space.
function _mmPositionMenu() {
  const menu = _mmEl();
  const chip = document.getElementById('model-chip');
  if (!menu || !chip) return;
  const parent = menu.offsetParent || menu.parentElement;
  if (!parent) return;
  const pRect = parent.getBoundingClientRect();
  const cRect = chip.getBoundingClientRect();
  menu.style.left = `${Math.max(0, cRect.left - pRect.left)}px`;
  // Sit the menu's bottom just above the chip (the CSS default anchors it to
  // the top of a tall container, floating it too high).
  menu.style.bottom = `${pRect.bottom - cRect.top + 8}px`;
}

function _mmShowEffort(row, modelFly, pid, model) {
  const menu = _mmEl();
  if (!menu) return;
  _mmHideEffort();
  const saved = laxGetSavedEffort();
  const fly = document.createElement('div');
  fly.className = 'mm-fly mm-effort';
  fly.setAttribute('role', 'menu');
  fly.innerHTML = `<div class="mm-head">Thinking</div>` + LAX_EFFORT_LEVELS.map(([v, label]) =>
    `<button class="mm-row${v === saved ? ' active' : ''}" data-effort="${v}" role="menuitem">${label}</button>`).join('');
  for (const opt of fly.querySelectorAll('.mm-row[data-effort]')) {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      closeModelMenu();
      laxSwitchModel(pid, model, opt.dataset.effort);
    });
  }
  menu.appendChild(fly);
  // Anchor just past the model flyout's right edge, overlapping a few px so
  // the pointer never crosses a dead gap that would feel like the flyout
  // "ran away".
  const menuLeft = menu.getBoundingClientRect().left;
  const flyRect = modelFly.getBoundingClientRect();
  _mmPositionFly(fly, row, flyRect.right - menuLeft - 4);
}

// Place `fly` at horizontal offset `left` (px from the menu's left edge),
// its top aligned with `anchorRow`, clamped inside the menu's height.
function _mmPositionFly(fly, anchorRow, left) {
  const menu = _mmEl();
  if (!menu) return;
  const menuRect = menu.getBoundingClientRect();
  const rowRect = anchorRow.getBoundingClientRect();
  fly.style.left = `${left}px`;
  const top = rowRect.top - menuRect.top;
  fly.style.top = `${Math.max(0, Math.min(top, menuRect.height - fly.offsetHeight))}px`;
}

// Outside click / Escape closes whichever popover is open. The chip and the
// speaker button stop propagation themselves, so any click landing here that
// isn't inside a popover means "dismiss".
document.addEventListener('click', (e) => {
  if (window._laxModelMenuOpen && !_mmEl()?.contains(e.target)) closeModelMenu();
  const pop = _vpEl();
  if (pop && pop.style.display !== 'none' && !pop.contains(e.target)) closeVoicePop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModelMenu(); closeVoicePop(); }
});
