// Settings → Appearance → My themes: the skin library (src/skins/). Each
// theme is a background picture or video, colors, how see-through the panels
// are and a moving layer; skin.js paints the one that is on. The list shows
// the built-in look first and then the user's themes; clicking one turns it
// on and opens it for editing below.
//
// The editor saves as you go and repaints the window while a slider moves,
// so there is nothing to apply: what you see is what is saved. Files go up
// through /api/upload first and are then copied into the theme. A change made
// in another tab, or by the agent's skin tool, arrives through skin.js
// (lax-skins-loaded) and redraws the list.
(function () {
  var COLORS = [['bg', 'Behind everything'], ['surface', 'Panels'], ['text', 'Text'], ['accent', 'Accent']];
  var FITS = [['cover', 'Fill the window'], ['contain', 'Show all of it'], ['tile', 'Repeat as tiles']];
  var editing = '';        // the slug open in the editor, '' for none
  var saveTimer = null;

  function $(id) { return document.getElementById(id); }
  function status(text) { var el = $('skin-status'); if (el) el.textContent = text || ''; }
  function skins() { return window.laxSkin ? window.laxSkin.list() : []; }
  function current() { return skins().find(function (s) { return s.slug === editing; }) || null; }
  function isVideo(file) { return /\.(mp4|webm)$/i.test(file || ''); }

  async function post(path, body, okText) {
    try {
      var r = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var data = await r.json();
      if (!r.ok) { status(data.error || 'That did not save.'); return null; }
      status(okText || '');
      return data;
    } catch (e) { status(e.message); return null; }
  }

  function card(slug, name, desc, preview, on) {
    return '<button type="button" class="theme-card' + (on ? ' active' : '') + '" data-skin="' + esc(slug) + '">' + preview +
      '<div class="theme-card-body"><div class="theme-card-name">' + esc(name) + '</div><div class="theme-card-desc">' + esc(desc) + '</div></div></button>';
  }
  function describe(s) {
    var parts = [];
    if (s.background) parts.push(isVideo(s.background) ? 'video background' : 'picture background');
    if (Object.keys(s.colors || {}).length) parts.push('own colors');
    if (s.effect) parts.push(s.effect.kind === 'custom' ? 'its own moving layer' : s.effect.kind);
    return parts.join(', ') || 'Nothing set yet';
  }
  function renderList() {
    var el = $('skin-list');
    if (!el || !window.laxSkin) return;
    var active = window.laxSkin.active();
    el.innerHTML = card('', 'Built-in look', 'The mode and theme chosen above', '<div class="skin-card-preview"></div>', !active) +
      skins().map(function (s) {
        var image = s.background && !isVideo(s.background) ? 'background-image:url(&quot;' + esc(window.laxSkin.fileUrl(s, s.background)) + '&quot;)' : '';
        var chips = COLORS.filter(function (c) { return s.colors[c[0]]; }).map(function (c) { return '<span title="' + c[1] + '" style="background:#' + esc(s.colors[c[0]]) + '"></span>'; }).join('');
        return card(s.slug, s.name, describe(s), '<div class="skin-card-preview" style="' + image + '">' + chips + '</div>', s.slug === active);
      }).join('');
    if (editing && !current()) closeEditor();
  }

  function slider(id, label, min, max, value, hint) {
    return '<label><span class="field-label">' + label + '</span><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" value="' + value + '">' +
      (hint ? '<span class="field-hint">' + hint + '</span>' : '') + '</label>';
  }
  function options(list, picked) {
    return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === picked ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }
  function renderEditor(s) {
    var fx = s.effect || { kind: '', density: 1, speed: 1, size: 1, reactive: false };
    var kinds = [['', 'None']].concat(window.laxEffects.list().map(function (e) { return [e.id, e.label]; }));
    if (s.code) kinds.push(['custom', 'Its own (written by the agent)']);
    var ed = $('skin-editor');
    ed.style.display = '';
    ed.innerHTML =
      '<div class="section-title">Edit theme</div>' +
      '<div class="skin-fields">' +
        '<label><span class="field-label">Name</span><input class="field-input" id="skin-name" maxlength="60" value="' + esc(s.name) + '"></label>' +
        '<label><span class="field-label">Background</span><input type="file" id="skin-bg-file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm">' +
          '<span class="field-hint">' + (s.background ? esc(s.background) + ' · <a href="#" id="skin-bg-remove" style="color:var(--accent)">Remove</a>' : 'A picture, GIF or short video, up to 10 MB.') + '</span></label>' +
        '<label><span class="field-label">Background fit</span><select class="field-select" id="skin-fit">' + options(FITS, s.fit) + '</select></label>' +
      '</div><div class="skin-fields">' +
        slider('skin-opacity', 'Panels: see-through to solid', 15, 100, Math.round(s.opacity * 100), 'How much of the background shows through the sidebars and message box.') +
        slider('skin-blur', 'Background blur', 0, 40, s.blur) +
        slider('skin-dim', 'Background dim', 0, 90, Math.round(s.dim * 100), 'Fades the background so text stays easy to read.') +
      '</div><div class="skin-fields">' +
        COLORS.map(function (c) {
          var has = !!s.colors[c[0]];
          return '<label class="skin-color"><input type="checkbox" data-skin-use="' + c[0] + '"' + (has ? ' checked' : '') + '>' +
            '<input type="color" data-skin-color="' + c[0] + '" value="#' + (has ? esc(s.colors[c[0]]).toLowerCase() : '888888') + '">' + c[1] + '</label>';
        }).join('') +
      '</div><div class="field-hint">Tick a color to use your own; unticked ones come from the theme chosen above. Text needs a panel or background color with it, and is adjusted until it is readable.</div>' +
      '<div class="skin-fields">' +
        '<label><span class="field-label">Moving layer</span><select class="field-select" id="skin-fx">' + options(kinds, fx.kind) + '</select></label>' +
        slider('skin-fx-density', 'Amount', 20, 300, Math.round(fx.density * 100)) +
        slider('skin-fx-speed', 'Speed', 20, 300, Math.round(fx.speed * 100)) +
        slider('skin-fx-size', 'Size', 50, 300, Math.round(fx.size * 100)) +
        '<label class="skin-color"><input type="checkbox" id="skin-fx-reactive"' + (fx.reactive ? ' checked' : '') + '>Grows as the chat\'s context fills</label>' +
      '</div>' +
      '<div class="btn-row"><button type="button" class="action-btn secondary" id="skin-close">Done</button>' +
      '<button type="button" class="action-btn danger" id="skin-delete">Delete theme</button></div>';
  }
  function closeEditor() { editing = ''; var ed = $('skin-editor'); if (ed) { ed.style.display = 'none'; ed.innerHTML = ''; } }

  /** The theme as the editor's fields now read. */
  function draft() {
    var s = current();
    var colors = {};
    COLORS.forEach(function (c) {
      var use = document.querySelector('[data-skin-use="' + c[0] + '"]'), color = document.querySelector('[data-skin-color="' + c[0] + '"]');
      // "" clears a color on the server; the layer reads it as not set.
      colors[c[0]] = use && use.checked ? color.value.replace('#', '').toUpperCase() : '';
    });
    var kind = $('skin-fx').value;
    return {
      name: $('skin-name').value.trim() || (s && s.name) || 'My theme',
      fit: $('skin-fit').value,
      opacity: +$('skin-opacity').value / 100, blur: +$('skin-blur').value, dim: +$('skin-dim').value / 100,
      colors: colors,
      effect: kind ? { kind: kind, density: +$('skin-fx-density').value / 100, speed: +$('skin-fx-speed').value / 100, size: +$('skin-fx-size').value / 100, reactive: $('skin-fx-reactive').checked } : null
    };
  }
  /** Repaint from the fields at once; the save follows a moment later. */
  function changed() {
    var s = current();
    if (!s) return;
    var d = draft(), shown = Object.assign({}, s, d, { colors: {}, effect: d.effect || undefined });
    Object.keys(d.colors).forEach(function (k) { if (d.colors[k]) shown.colors[k] = d.colors[k]; });
    window.laxSkin.draft(shown);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  async function save() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!editing) return;
    if (await post('/api/skins/save', { ref: editing, skin: draft() }, 'Saved.')) await window.laxSkin.load();
  }

  async function open(slug) {
    if (saveTimer) await save();
    window.laxSkin.use(slug);
    editing = slug;
    var s = current();
    if (s) renderEditor(s); else closeEditor();
    renderList();
  }
  async function create() {
    var taken = skins().map(function (s) { return s.name.toLowerCase(); }), name = 'My theme';
    for (var i = 2; taken.indexOf(name.toLowerCase()) >= 0; i++) name = 'My theme ' + i;
    var r = await post('/api/skins/save', { skin: { name: name } }, 'Made ' + name + '. Pick a background or colors below.');
    if (!r) return;
    await window.laxSkin.load();
    open(r.skin.slug);
  }
  async function setBackground(file) {
    if (saveTimer) await save();
    status('Uploading ' + file.name + '…');
    try {
      var form = new FormData();
      form.append('file', file, file.name);
      var r = await apiFetch('/api/upload', { method: 'POST', body: form });
      var data = await r.json();
      if (!r.ok || !data.files || !data.files[0]) throw new Error(data.error || 'Upload failed');
      if (await post('/api/skins/background', { skin: editing, upload: data.files[0].url, name: file.name }, 'Background set.')) { await window.laxSkin.load(); open(editing); }
    } catch (e) { status(e.message); }
  }

  function wire() {
    var list = $('skin-list'), ed = $('skin-editor');
    if (!list || !ed) return;
    $('skin-new').addEventListener('click', create);
    list.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-skin]');
      if (btn) open(btn.getAttribute('data-skin'));
    });
    ed.addEventListener('input', function (ev) { if (ev.target.type !== 'file') changed(); });
    ed.addEventListener('change', function (ev) { if (ev.target.id === 'skin-bg-file' && ev.target.files[0]) setBackground(ev.target.files[0]); });
    ed.addEventListener('click', async function (ev) {
      var id = ev.target.id;
      if (id === 'skin-close') { if (saveTimer) await save(); closeEditor(); }
      else if (id === 'skin-bg-remove') {
        ev.preventDefault();
        if (await post('/api/skins/remove-background', { skin: editing }, 'Background removed.')) { await window.laxSkin.load(); open(editing); }
      } else if (id === 'skin-delete') {
        var s = current();
        if (!s || !confirm('Delete the ' + s.name + ' theme? Its folder goes to the trash, where you can restore it, and it is removed from your other synced computers.')) return;
        clearTimeout(saveTimer); saveTimer = null;
        if (await post('/api/skins/remove', { skin: editing }, 'Deleted ' + s.name + '.')) { closeEditor(); await window.laxSkin.load(); }
      }
    });
    document.addEventListener('lax-skins-loaded', renderList);
    document.addEventListener('lax-effect-error', function (ev) { status('This theme\'s moving layer stopped: ' + ev.detail); });
    renderList();
  }

  document.addEventListener('DOMContentLoaded', wire);
}());
