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

// Render the two columns for `pid` (defaults to the active provider). The
// effort flyout is a third, absolutely-positioned element created on model
// hover — not a column — so it can align with the hovered row.
function _mmRender(pid) {
  const menu = _mmEl();
  if (!menu) return;
  const data = _providersCache || {};
  const providers = data.providers || [];
  const current = data.current || {};
  if (!providers.length) {
    menu.innerHTML = `<div class="mm-col"><div class="mm-head">Loading providers…</div></div>`;
    return;
  }
  const activeP = providers.find(p => p.active) || providers[0];
  const shownPid = pid || activeP.id;
  const shown = providers.find(p => p.id === shownPid) || activeP;

  const provRows = providers.map(p =>
    `<button class="mm-row${p.id === shownPid ? ' hl' : ''}${p.active ? ' active' : ''}" data-pid="${esc(p.id)}" role="menuitem">
       ${esc(p.name)}<span class="mm-arrow">&#9654;</span></button>`).join('');

  const models = Array.isArray(shown.models) ? shown.models : [];
  const modelRows = models.length ? models.map(m => {
    const tier = classifyModelTier(m);
    const isCurrent = shown.active && m === current.model;
    const tag = isCurrent ? `<span class="mm-tag mm-check">&#10003;</span>`
      : tier !== 'strong' ? `<span class="mm-tag">${tier}</span>` : `<span class="mm-tag"></span>`;
    return `<button class="mm-row${isCurrent ? ' active' : ''}" data-model="${esc(m)}" role="menuitem">${esc(m)}${tag}</button>`;
  }).join('') : `<div class="mm-head">No models</div>`;

  menu.innerHTML = `
    <div class="mm-cols">
      <div class="mm-col"><div class="mm-head">Provider</div>${provRows}</div>
      <div class="mm-col mm-model-col"><div class="mm-head">Model &#183; hover for thinking</div>${modelRows}</div>
    </div>`;

  for (const row of menu.querySelectorAll('.mm-row[data-pid]')) {
    const go = () => { if (row.dataset.pid !== shownPid) _mmRender(row.dataset.pid); };
    row.addEventListener('mouseenter', go);
    row.addEventListener('click', go);
  }
  const modelCol = menu.querySelector('.mm-model-col');
  for (const row of menu.querySelectorAll('.mm-row[data-model]')) {
    row.addEventListener('mouseenter', () => _mmShowEffort(row, shown.id, row.dataset.model));
    row.addEventListener('click', () => {
      closeModelMenu();
      laxSwitchModel(shown.id, row.dataset.model);
    });
  }
  // The flyout is anchored to a row's offsetTop; scrolling the model list
  // would leave it floating over the wrong row — just hide it.
  modelCol?.addEventListener('scroll', _mmHideEffort);
}

function _mmHideEffort() {
  _mmEl()?.querySelector('.mm-effort')?.remove();
}

function _mmShowEffort(row, pid, model) {
  const menu = _mmEl();
  if (!menu) return;
  _mmHideEffort();
  const saved = laxGetSavedEffort();
  const fly = document.createElement('div');
  fly.className = 'mm-effort';
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
  // Align the flyout's top with the hovered row, overlapping the menu edge
  // by a few px so the pointer never crosses a dead gap that would feel
  // like the flyout "ran away".
  const menuRect = menu.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  fly.style.left = `${menuRect.width - 4}px`;
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
