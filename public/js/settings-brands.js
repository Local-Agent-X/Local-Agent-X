// Settings → Brands: the brand library (src/tools/shared/brand-store.ts). Each
// company's colors, fonts, logo, letterhead, templates and rules, which the
// Office tools apply to the files made for it. Lists the brands with their
// colors and logo; the editor below saves through /api/brands, files go up
// through /api/upload first and are then copied into the brand. A change made
// in another tab, or by the agent's brand tool, repaints through loadBrands.
(function () {
  var COLOR_ROLES = [['primary', 'Main color'], ['secondary', 'Second color'], ['accent', 'Accent'], ['dark', 'Dark (covers, titles)'], ['light', 'Light (cards)']];
  var IMAGES = [['logo', 'logo', 'Logo'], ['logoOnDark', 'logo_on_dark', 'Logo for dark backgrounds'], ['letterhead', 'letterhead', 'Letterhead (top of documents and PDFs)']];
  var KINDS = [['deck', 'Decks'], ['doc', 'Documents'], ['pdf', 'PDFs'], ['sheet', 'Spreadsheets'], ['email', 'Emails']];
  var brands = [];
  var editing = null; // the slug being edited, '' for a new brand

  function esc2(s) { return typeof esc === 'function' ? esc(s == null ? '' : s) : String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function fileUrl(slug, file) { return '/brands/' + encodeURIComponent(slug) + '/' + encodeURIComponent(file) + '?token=' + encodeURIComponent(AUTH_TOKEN) + '&t=' + Date.now(); }
  function status(text) { var el = $('brand-status'); if (el) el.textContent = text || ''; }
  function editorStatus(text) { var el = $('brand-ed-status'); if (el) el.textContent = text || ''; }
  function swatches(b) {
    return COLOR_ROLES.filter(function (r) { return b.colors[r[0]]; }).map(function (r) {
      return '<span title="' + r[1] + ' #' + esc2(b.colors[r[0]]) + '" style="display:inline-block;width:16px;height:16px;border-radius:4px;border:1px solid var(--border);background:#' + esc2(b.colors[r[0]]) + '"></span>';
    }).join('');
  }

  function renderList() {
    var el = $('brand-list');
    if (!el) return;
    if (!brands.length) { el.innerHTML = '<div class="field-hint">No brands yet. Files are made in the built-in designs until you add one.</div>'; return; }
    el.innerHTML = brands.map(function (b) {
      var logo = b.logo ? '<img alt="" src="' + fileUrl(b.slug, b.logo) + '" style="height:22px;max-width:80px;object-fit:contain">' : '';
      return '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">'
        + logo + '<strong>' + esc2(b.name) + '</strong>'
        + (b.isDefault ? '<span class="field-hint" style="border:1px solid var(--border);border-radius:10px;padding:0 8px">default</span>' : '')
        + '<span style="display:flex;gap:3px">' + swatches(b) + '</span><span style="flex:1"></span>'
        + '<button type="button" class="notif-btn" data-brand-edit="' + esc2(b.slug) + '">Edit</button></div>';
    }).join('');
  }

  async function loadBrands() {
    try {
      var data = await apiJson('/api/brands');
      brands = Array.isArray(data.brands) ? data.brands : [];
      renderList();
      if (editing) { var b = brands.find(function (x) { return x.slug === editing; }); if (b) renderEditor(b); else closeEditor(); }
    } catch (e) {
      var el = $('brand-list');
      if (el) el.textContent = "Couldn't load your brands.";
    }
  }

  function field(id, label, value, placeholder) {
    return '<div class="field"><label class="field-label" for="' + id + '">' + label + '</label><input class="field-input" id="' + id + '" value="' + esc2(value) + '" placeholder="' + esc2(placeholder || '') + '" autocomplete="off"/></div>';
  }
  function area(id, label, value, placeholder) {
    return '<div class="field"><label class="field-label" for="' + id + '">' + label + '</label><textarea class="field-input" id="' + id + '" rows="2" placeholder="' + esc2(placeholder || '') + '">' + esc2(value) + '</textarea></div>';
  }

  function imagesBlock(b) {
    if (!b.slug) return '<div class="field-hint" style="margin-top:10px">Save the brand first, then add its logo, letterhead and templates.</div>';
    var rows = IMAGES.map(function (im) {
      var file = b[im[0]];
      return '<div style="display:flex;align-items:center;gap:10px;margin-top:6px"><span style="width:200px;flex-shrink:0">' + im[2] + '</span>'
        + (file ? '<img alt="" src="' + fileUrl(b.slug, file) + '" style="height:28px;max-width:160px;object-fit:contain;border:1px solid var(--border);border-radius:4px;padding:2px">'
          + '<button type="button" class="notif-btn" data-brand-remove-file="' + esc2(file) + '">Remove</button>' : '<span class="field-hint">none</span>')
        + '<input type="file" accept="image/*" data-brand-upload-role="' + im[1] + '" aria-label="Upload ' + im[2] + '"></div>';
    }).join('');
    var files = (b.assets || []).map(function (a) {
      return '<div style="display:flex;align-items:center;gap:8px;margin-top:4px"><a href="' + fileUrl(b.slug, a.file) + '">' + esc2(a.file) + '</a><span class="field-hint">' + esc2(a.kind) + (a.note ? ' · ' + esc2(a.note) : '') + '</span>'
        + '<button type="button" class="notif-btn" data-brand-remove-file="' + esc2(a.file) + '">Remove</button></div>';
    }).join('') || '<div class="field-hint">No templates or reference files yet.</div>';
    return '<div class="section-title" style="margin-top:16px;font-size:.9rem">Logo and letterhead</div>' + rows
      + '<div class="section-title" style="margin-top:16px;font-size:.9rem">Templates and reference files</div>' + files
      + '<div class="field-row" style="margin-top:6px"><div class="field"><label class="field-label" for="brand-asset-kind">Kind</label><select class="field-input" id="brand-asset-kind"><option value="template">Template (.pptx, .potx, .docx, .dotx, .xlsx)</option><option value="reference">Reference (PDF, document, image)</option><option value="image">Image</option></select></div>'
      + field('brand-asset-note', 'What it is for', '', 'Sales deck template')
      + '<div class="field"><label class="field-label" for="brand-asset-file">File (up to 10 MB)</label><input type="file" id="brand-asset-file" class="field-input"></div></div>'
      + '<div class="section-title" style="margin-top:16px;font-size:.9rem">Import the look</div>'
      + '<div class="field-hint">Read colors and fonts from a PowerPoint or Word template or a logo, or from the company\'s website. You can change what it picks.</div>'
      + '<div class="field-row" style="margin-top:6px"><div class="field"><label class="field-label" for="brand-import-file">Template or logo</label><input type="file" id="brand-import-file" class="field-input" accept=".pptx,.potx,.docx,.dotx,.xlsx,.xltx,image/*"></div>'
      + field('brand-import-url', 'Website', '', 'https://nutrishop.com') + '</div>'
      + '<div class="btn-row"><button type="button" class="action-btn secondary" id="brand-import-site">Import from website</button></div>';
  }

  function renderEditor(b) {
    var el = $('brand-editor');
    if (!el) return;
    el.style.display = '';
    var colors = COLOR_ROLES.map(function (r) {
      var v = b.colors[r[0]] ? '#' + b.colors[r[0]] : '';
      return '<div class="field"><label class="field-label" for="brand-c-' + r[0] + '">' + r[1] + '</label><div style="display:flex;gap:6px;align-items:center">'
        + '<input type="color" id="brand-cp-' + r[0] + '" value="' + esc2(v || '#ffffff') + '" aria-label="Pick ' + r[1] + '" style="width:34px;height:30px;padding:0;border:1px solid var(--border);border-radius:4px">'
        + '<input class="field-input" id="brand-c-' + r[0] + '" value="' + esc2(v) + '" placeholder="none" autocomplete="off"/></div></div>';
    }).join('');
    el.innerHTML = '<div class="section-title">' + (b.slug ? esc2(b.name) : 'New brand') + '</div>'
      + '<div class="field-row">' + field('brand-name', 'Name', b.name, 'NutriShop') + field('brand-aliases', 'Also called (comma between)', (b.aliases || []).join(', '), 'the store, NS McKinney') + '</div>'
      + '<label class="field-hint" style="display:flex;align-items:center;gap:8px;margin-top:6px"><input type="checkbox" id="brand-default"' + (b.isDefault ? ' checked' : '') + '> Use for every file that names no brand</label>'
      + '<div class="section-title" style="margin-top:16px;font-size:.9rem">Colors</div><div class="field-hint">Readable shades for text and backgrounds are worked out from these.</div><div class="field-row">' + colors + '</div>'
      + '<div class="field-row">' + field('brand-font-heading', 'Heading font', b.fonts.heading, 'Montserrat') + field('brand-font-body', 'Body font', b.fonts.body, 'Open Sans') + '</div>'
      + '<div class="field-row">' + field('brand-company', 'Company', b.company, 'NutriShop McKinney') + field('brand-footer', 'Footer line', b.footer, 'NutriShop · 123 Main St') + field('brand-author', 'File author', b.author, '') + '</div>'
      + '<div class="section-title" style="margin-top:16px;font-size:.9rem">Rules</div><div class="field-hint">The agent is handed these with every file in this brand and checks the file against them.</div>'
      + area('brand-notes', 'For everything', b.notes, 'Always "NutriShop", one word. Never use stock photos of pills.')
      + KINDS.map(function (k) { return area('brand-rule-' + k[0], k[1], (b.rules || {})[k[0]], ''); }).join('')
      + imagesBlock(b)
      + '<div class="btn-row" style="margin-top:14px"><button type="button" class="action-btn primary" id="brand-save">Save</button><button type="button" class="action-btn secondary" id="brand-cancel">Close</button>'
      + (b.slug ? '<button type="button" class="action-btn secondary" id="brand-delete" style="margin-left:auto">Delete brand</button>' : '')
      + '<span id="brand-ed-status" class="field-hint" aria-live="polite"></span></div>';
    COLOR_ROLES.forEach(function (r) {
      $('brand-cp-' + r[0]).addEventListener('input', function (ev) { $('brand-c-' + r[0]).value = ev.target.value.toUpperCase(); });
    });
  }

  function closeEditor() { editing = null; var el = $('brand-editor'); if (el) { el.style.display = 'none'; el.innerHTML = ''; } }

  function formBrand() {
    var colors = {}, rules = {};
    COLOR_ROLES.forEach(function (r) { colors[r[0]] = $('brand-c-' + r[0]).value.trim(); });
    KINDS.forEach(function (k) { rules[k[0]] = $('brand-rule-' + k[0]).value; });
    return {
      name: $('brand-name').value.trim(),
      aliases: $('brand-aliases').value.split(',').map(function (a) { return a.trim(); }).filter(Boolean),
      isDefault: $('brand-default').checked,
      colors: colors, rules: rules,
      fonts: { heading: $('brand-font-heading').value, body: $('brand-font-body').value },
      company: $('brand-company').value, footer: $('brand-footer').value, author: $('brand-author').value, notes: $('brand-notes').value,
    };
  }

  async function post(path, body, done) {
    editorStatus('Working…');
    try {
      var r = await apiPost(path, body);
      if (!r.ok) throw new Error(r.error || 'That did not work');
      editorStatus(done || 'Saved.');
      return r;
    } catch (e) { editorStatus(e && e.message ? e.message : 'That did not work'); return null; }
  }

  async function save() {
    var b = formBrand();
    if (!b.name) { editorStatus('Give the brand a name.'); return; }
    var r = await post('/api/brands/save', { ref: editing || undefined, brand: b });
    if (r) { editing = r.brand.slug; await loadBrands(); editorStatus('Saved.'); }
  }

  async function upload(file) {
    var form = new FormData();
    form.append('file', file, file.name);
    var r = await apiFetch('/api/upload', { method: 'POST', body: form });
    var data = await r.json();
    if (!r.ok || !data.files || !data.files[0]) throw new Error(data.error || 'Upload failed');
    return data.files[0];
  }

  async function addFile(file, role, note) {
    editorStatus('Uploading…');
    try {
      var up = await upload(file);
      if (await post('/api/brands/file', { brand: editing, upload: up.url, name: file.name, role: role, note: note }, 'Added ' + file.name + '.')) await loadBrands();
    } catch (e) { editorStatus(e.message); }
  }

  async function importFile(file) {
    editorStatus('Reading ' + file.name + '…');
    try {
      var up = await upload(file);
      var r = await post('/api/brands/import', { brand: editing, upload: up.url, name: file.name });
      if (r) { await loadBrands(); editorStatus('Read ' + (r.found.found || []).length + ' colors from ' + file.name + '. Check them and save.'); }
    } catch (e) { editorStatus(e.message); }
  }

  async function importSite() {
    var url = $('brand-import-url').value.trim();
    if (!url) { editorStatus('Type the website address.'); return; }
    editorStatus('Reading ' + url + '…');
    var r = await post('/api/brands/import', { brand: editing, url: url });
    if (r) { await loadBrands(); editorStatus('Read ' + (r.found.found || []).length + ' colors from the site' + (r.brand.logo ? ' and its logo' : '') + '. Check them and save.'); }
  }

  function wire() {
    var list = $('brand-list');
    if (!list) return;
    $('brand-new').addEventListener('click', function () { editing = ''; renderEditor({ name: '', aliases: [], colors: {}, fonts: {}, rules: {}, assets: [] }); });
    list.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-brand-edit]');
      if (!btn) return;
      editing = btn.getAttribute('data-brand-edit');
      var b = brands.find(function (x) { return x.slug === editing; });
      if (b) renderEditor(b);
    });
    var ed = $('brand-editor');
    ed.addEventListener('click', async function (ev) {
      var t = ev.target;
      if (t.id === 'brand-save') save();
      else if (t.id === 'brand-cancel') closeEditor();
      else if (t.id === 'brand-import-site') importSite();
      else if (t.id === 'brand-delete') {
        var name = $('brand-name').value || editing;
        if (!confirm('Delete the ' + name + ' brand? Its folder goes to the trash, where you can restore it, and it is removed from your other synced computers.')) return;
        if (await post('/api/brands/remove', { brand: editing }, 'Deleted.')) { closeEditor(); status('Deleted ' + name + '.'); loadBrands(); }
      } else if (t.hasAttribute && t.hasAttribute('data-brand-remove-file')) {
        if (await post('/api/brands/remove-file', { brand: editing, file: t.getAttribute('data-brand-remove-file') }, 'Removed.')) loadBrands();
      }
    });
    ed.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t.files || !t.files[0]) return;
      if (t.hasAttribute('data-brand-upload-role')) addFile(t.files[0], t.getAttribute('data-brand-upload-role'));
      else if (t.id === 'brand-asset-file') addFile(t.files[0], $('brand-asset-kind').value, $('brand-asset-note').value);
      else if (t.id === 'brand-import-file') importFile(t.files[0]);
    });
    loadBrands();
  }

  window.loadBrands = loadBrands;
  document.addEventListener('DOMContentLoaded', wire);
}());
