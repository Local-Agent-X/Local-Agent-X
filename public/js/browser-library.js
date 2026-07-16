// Browser library — bookmarks + history overlay behind the "Library" button in
// the right-panel Browser tab (public/app.html #browser-library-panel). Plain
// DOM panel over the native WebContentsView, same occlusion contract as
// browser-profiles.js: opening toggles display and pokes laxBrowserTab.sync().
//
// Backed by the shared stores over HTTP (src/routes/browser/):
//   GET    /api/browser/bookmarks           — list (?q=)
//   POST   /api/browser/bookmarks           — add { url, title } (addedBy:"user")
//   DELETE /api/browser/bookmarks/:id       — remove
//   GET    /api/browser/history             — list (?q=&limit=)
//   DELETE /api/browser/history/:id         — delete one entry
//   DELETE /api/browser/history             — clear ALL history (double-confirm)
//
// Also owns the address-bar <datalist> suggestions (#browser-url-suggestions):
// refreshed from the last history GET on panel open + browser-tab click — no
// per-keystroke queries.

(function () {
	var HISTORY_LIMIT = 100;
	var SUGGESTION_LIMIT = 20;

	function panel() { return document.getElementById('browser-library-panel'); }

	// Canonical authed fetch (shared-api.js) — same shim as browser-profiles.js.
	function api(path, opts) {
		if (typeof apiFetch === 'function') return apiFetch(path, opts);
		var base = (typeof API === 'string') ? API : '';
		var o = opts || {};
		var headers = {};
		for (var k in (o.headers || {})) headers[k] = o.headers[k];
		if (typeof AUTH_TOKEN === 'string') headers.Authorization = 'Bearer ' + AUTH_TOKEN;
		return fetch(base + path, { method: o.method, headers: headers, body: o.body });
	}

	function relTime(ts) {
		if (!ts) return '';
		var d = Date.now() - ts;
		if (d < 60000) return 'just now';
		if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
		if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
		if (d < 604800000) return Math.floor(d / 86400000) + 'd ago';
		try { return new Date(ts).toLocaleDateString(); } catch (e) { return ''; }
	}

	// ── State ─────────
	var isOpen = false;
	var historyQuery = '';

	function setError(msg) {
		var el = document.getElementById('browser-library-error');
		if (el) { el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; }
	}

	// ── Data ops ─────────
	function loadBookmarks() {
		return Promise.resolve(api('/api/browser/bookmarks', {}))
			.then(function (r) { return r.json(); })
			.catch(function () { return []; });
	}

	function loadHistory(q) {
		var qs = '?limit=' + HISTORY_LIMIT + (q ? '&q=' + encodeURIComponent(q) : '');
		return Promise.resolve(api('/api/browser/history' + qs, {}))
			.then(function (r) { return r.json(); })
			.catch(function () { return []; });
	}

	function refresh() {
		return Promise.all([loadBookmarks(), loadHistory(historyQuery)]).then(function (res) {
			render(Array.isArray(res[0]) ? res[0] : [], Array.isArray(res[1]) ? res[1] : []);
			refreshSuggestions();
		});
	}

	// ── Address-bar suggestions ─────────
	// Top recent history urls into the <datalist> the address bar points at.
	function refreshSuggestions() {
		var list = document.getElementById('browser-url-suggestions');
		if (!list) return Promise.resolve();
		return loadHistory('').then(function (entries) {
			if (!Array.isArray(entries)) return;
			list.innerHTML = '';
			var seen = {};
			for (var i = 0; i < entries.length && list.children.length < SUGGESTION_LIMIT; i++) {
				var url = entries[i] && entries[i].url;
				if (!url || seen[url]) continue;
				seen[url] = true;
				var opt = document.createElement('option');
				opt.value = url;
				if (entries[i].title) opt.label = entries[i].title;
				list.appendChild(opt);
			}
		});
	}

	function bookmarkCurrentPage() {
		var input = document.getElementById('browser-url-input');
		var url = input ? (input.value || '').trim() : '';
		if (!url) { setError('Nothing to bookmark — the address bar is empty'); return; }
		setError('');
		Promise.resolve(api('/api/browser/bookmarks', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url }),
		}))
			.then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
			.then(function (res) {
				if (!res.ok) { setError((res.body && res.body.error) || 'Could not save bookmark'); return; }
				refresh();
			})
			.catch(function () { setError('Could not save bookmark'); });
	}

	function deleteBookmark(bm) {
		if (!window.confirm('Remove bookmark "' + (bm.title || bm.url) + '"?')) return;
		setError('');
		Promise.resolve(api('/api/browser/bookmarks/' + encodeURIComponent(bm.id), { method: 'DELETE' }))
			.then(function () { refresh(); })
			.catch(function () { setError('Could not remove bookmark'); });
	}

	function deleteHistoryEntry(entry) {
		setError('');
		Promise.resolve(api('/api/browser/history/' + encodeURIComponent(entry.id), { method: 'DELETE' }))
			.then(function () { refresh(); })
			.catch(function () { setError('Could not delete entry'); });
	}

	// Destructive — DOUBLE confirm (same posture as profile delete).
	function clearHistory() {
		if (!window.confirm('Clear ALL browser history?')) return;
		if (!window.confirm('This cannot be undone. Clear history for good?')) return;
		setError('');
		Promise.resolve(api('/api/browser/history', { method: 'DELETE' }))
			.then(function () { refresh(); })
			.catch(function () { setError('Could not clear history'); });
	}

	// ── Render ─────────
	function actionButton(label, title, onClick) {
		var btn = document.createElement('button');
		btn.className = 'artifact-filter';
		btn.textContent = label;
		if (title) btn.title = title;
		btn.addEventListener('click', onClick);
		return btn;
	}

	function sectionHead(label, button) {
		var head = document.createElement('div');
		head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border)';
		var title = document.createElement('div');
		title.textContent = label;
		title.style.cssText = 'flex:1;font-size:.7rem;color:var(--text);text-transform:uppercase;letter-spacing:.04em';
		head.appendChild(title);
		if (button) head.appendChild(button);
		return head;
	}

	function emptyRow(text) {
		var row = document.createElement('div');
		row.textContent = text;
		row.style.cssText = 'padding:10px 8px;font-size:.66rem;color:var(--text-dim)';
		return row;
	}

	function itemRow(main, sub, buttons) {
		var row = document.createElement('div');
		row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border)';
		var meta = document.createElement('div');
		meta.style.cssText = 'flex:1;min-width:0';
		var name = document.createElement('div');
		name.textContent = main;
		name.style.cssText = 'font-size:.7rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
		var subEl = document.createElement('div');
		subEl.textContent = sub;
		subEl.style.cssText = 'font-size:.6rem;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
		meta.appendChild(name);
		meta.appendChild(subEl);
		row.appendChild(meta);
		for (var i = 0; i < buttons.length; i++) row.appendChild(buttons[i]);
		return row;
	}

	function navigateTo(url) {
		var input = document.getElementById('browser-url-input');
		if (input) input.value = url;
		close();
		if (window.laxBrowserTab && window.laxBrowserTab.navigateFromInput) window.laxBrowserTab.navigateFromInput();
	}

	function render(bookmarks, history) {
		var p = panel();
		if (!p) return;
		p.innerHTML = '';

		var head = document.createElement('div');
		head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border)';
		var title = document.createElement('div');
		title.textContent = 'Library';
		title.style.cssText = 'flex:1;font-size:.74rem;color:var(--text)';
		head.appendChild(title);
		head.appendChild(actionButton('Close', 'Close library', close));
		p.appendChild(head);

		var err = document.createElement('div');
		err.id = 'browser-library-error';
		err.style.cssText = 'display:none;padding:6px 8px;font-size:.66rem;color:var(--danger,#e5484d)';
		p.appendChild(err);

		// ── Bookmarks ──
		p.appendChild(sectionHead('Bookmarks', actionButton('Bookmark current page', 'Save the page in the address bar', bookmarkCurrentPage)));
		var bmList = document.createElement('div');
		bmList.id = 'browser-library-bookmarks';
		if (bookmarks.length === 0) bmList.appendChild(emptyRow('No bookmarks yet — shared between you and your agents.'));
		for (var i = 0; i < bookmarks.length; i++) {
			(function (bm) {
				var openBtn = actionButton('Open', 'Open in the browser tab', function () { navigateTo(bm.url); });
				var delBtn = actionButton('Remove', 'Remove this bookmark', function () { deleteBookmark(bm); });
				var sub = bm.url + ' · ' + (bm.addedBy === 'agent' ? 'agent' : 'you') + ' · ' + relTime(bm.ts) +
					(bm.tags && bm.tags.length ? ' · ' + bm.tags.join(', ') : '');
				bmList.appendChild(itemRow(bm.title || bm.url, sub, [openBtn, delBtn]));
			})(bookmarks[i]);
		}
		p.appendChild(bmList);

		// ── History ──
		p.appendChild(sectionHead('History', actionButton('Clear', 'Delete ALL history', clearHistory)));
		var searchWrap = document.createElement('div');
		searchWrap.style.cssText = 'display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--border)';
		var search = document.createElement('input');
		search.id = 'browser-library-history-search';
		search.type = 'text';
		search.placeholder = 'Search history';
		search.value = historyQuery;
		search.setAttribute('autocomplete', 'off');
		search.style.cssText = 'flex:1;min-width:0;background:transparent;border:1px solid var(--border);color:var(--text);font-size:.68rem;padding:4px 8px;border-radius:4px;outline:none';
		search.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { e.preventDefault(); historyQuery = (search.value || '').trim(); refresh(); }
		});
		searchWrap.appendChild(search);
		p.appendChild(searchWrap);

		var histList = document.createElement('div');
		histList.id = 'browser-library-history';
		if (history.length === 0) histList.appendChild(emptyRow(historyQuery ? 'No history matches "' + historyQuery + '".' : 'No history yet.'));
		for (var j = 0; j < history.length; j++) {
			(function (entry) {
				var openBtn = actionButton('Open', 'Open in the browser tab', function () { navigateTo(entry.url); });
				var delBtn = actionButton('Delete', 'Delete this entry', function () { deleteHistoryEntry(entry); });
				histList.appendChild(itemRow(entry.title || entry.url, entry.url + ' · ' + relTime(entry.ts), [openBtn, delBtn]));
			})(history[j]);
		}
		p.appendChild(histList);
	}

	// ── Open / close ─────────
	function open() {
		var p = panel();
		if (!p) return;
		isOpen = true;
		p.style.display = 'block';
		// Close the profiles panel if it's up — one overlay at a time.
		if (window.laxBrowserProfiles && window.laxBrowserProfiles.isOpen && window.laxBrowserProfiles.isOpen()) {
			window.laxBrowserProfiles.close();
		}
		if (window.laxBrowserTab && window.laxBrowserTab.sync) window.laxBrowserTab.sync();
		refresh();
	}

	function close() {
		var p = panel();
		if (!p) return;
		isOpen = false;
		p.style.display = 'none';
		if (window.laxBrowserTab && window.laxBrowserTab.sync) window.laxBrowserTab.sync();
	}

	function toggle() { if (isOpen) close(); else open(); }

	// Refresh address-bar suggestions when the browser tab is shown (tab button
	// click) — cheap listener, no coupling into browser-tab.js internals.
	var browserTabBtn = document.getElementById('side-tab-browser');
	if (browserTabBtn) browserTabBtn.addEventListener('click', function () { refreshSuggestions(); });

	window.laxBrowserLibrary = {
		toggle: toggle,
		open: open,
		close: close,
		refresh: refresh,
		refreshSuggestions: refreshSuggestions,
		// Exposed for tests + programmatic use.
		render: render,
		isOpen: function () { return isOpen; },
	};
})();
