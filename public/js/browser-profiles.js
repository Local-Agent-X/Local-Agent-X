// Browser profile manager — the overlay behind the "Profiles" button in the
// right-panel Browser tab (public/app.html #browser-profiles-panel). It is a
// plain DOM panel (NOT a native view), so it can safely draw ON TOP of the
// WebContentsView overlay: opening it toggles #browser-profiles-panel to
// display:block, whose inset:0 box wins browser-tab.js's occlusion probe and
// hides the native view until the panel closes again.
//
// A profile is a named, persistent browsing identity (BrowserProfileStore,
// src/browser/profile-store.js) with saved logins. This panel is the CRUD UI
// over the HTTP routes (src/routes/browser/profiles.ts):
//   GET    /api/browser/profiles            — list
//   POST   /api/browser/profiles            — create { name }
//   PUT    /api/browser/profiles/:id        — rename { name }
//   DELETE /api/browser/profiles/:id        — delete (refused for "default")
//   DELETE /api/browser/profiles/:id/data   — clear saved logins (default too)
// plus the desktop-only "Log in once" IPC (window.desktop.browser.openProfileView)
// that opens a real foreground view on the profile's partition so the user can
// sign in by hand.
//
// Destructive ops (delete, clear-logins) double-confirm before firing.

(function () {
	var DEFAULT_ID = 'default';

	function panel() { return document.getElementById('browser-profiles-panel'); }
	function bridge() { return (window.desktop && window.desktop.browser) || null; }

	// Canonical authed fetch (shared-api.js). apiFetch prepends API and the
	// Bearer token; every other panel goes through it, so profiles do too.
	function api(path, opts) {
		if (typeof apiFetch === 'function') return apiFetch(path, opts);
		var base = (typeof API === 'string') ? API : '';
		var o = opts || {};
		var headers = {};
		for (var k in (o.headers || {})) headers[k] = o.headers[k];
		if (typeof AUTH_TOKEN === 'string') headers.Authorization = 'Bearer ' + AUTH_TOKEN;
		return fetch(base + path, { method: o.method, headers: headers, body: o.body });
	}

	function jsonBody(body) {
		return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
	}

	// ── Formatting ─────────
	function relTime(ts) {
		if (!ts) return 'never';
		var d = Date.now() - ts;
		if (d < 60000) return 'just now';
		if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
		if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
		if (d < 604800000) return Math.floor(d / 86400000) + 'd ago';
		try { return new Date(ts).toLocaleDateString(); } catch (e) { return ''; }
	}

	// ── State ─────────
	var isOpen = false;

	function setError(msg) {
		var el = document.getElementById('browser-profiles-error');
		if (el) { el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; }
	}

	// ── Data ops ─────────
	function loadProfiles() {
		return Promise.resolve(api('/api/browser/profiles', {}))
			.then(function (r) { return r.json(); })
			.catch(function () { return []; });
	}

	function refresh() {
		return loadProfiles().then(function (list) { render(Array.isArray(list) ? list : []); });
	}

	function createProfile() {
		var input = document.getElementById('browser-profiles-name-input');
		if (!input) return;
		var name = (input.value || '').trim();
		if (!name) { setError('Enter a profile name'); return; }
		setError('');
		Promise.resolve(api('/api/browser/profiles', jsonBody({ name: name })))
			.then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
			.then(function (res) {
				if (!res.ok) { setError((res.body && res.body.error) || 'Could not create profile'); return; }
				input.value = '';
				refresh();
			})
			.catch(function () { setError('Could not create profile'); });
	}

	function renameProfile(profile) {
		var next = window.prompt('Rename profile', profile.name);
		if (next == null) return; // cancelled
		next = next.trim();
		if (!next || next === profile.name) return;
		setError('');
		Promise.resolve(api('/api/browser/profiles/' + encodeURIComponent(profile.id), {
			method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: next }),
		}))
			.then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
			.then(function (res) {
				if (!res.ok) { setError((res.body && res.body.error) || 'Could not rename profile'); return; }
				refresh();
			})
			.catch(function () { setError('Could not rename profile'); });
	}

	// Destructive — DOUBLE confirm. Deleting drops the profile record; the saved
	// logins on disk are cleared separately (server-side delete leaves them, so a
	// tidy delete clears first, but the record removal is the user-facing intent).
	function deleteProfile(profile) {
		if (profile.id === DEFAULT_ID) return; // guarded in the store + route too
		if (!window.confirm('Delete profile "' + profile.name + '"? Its saved logins will be removed.')) return;
		if (!window.confirm('This cannot be undone. Delete "' + profile.name + '" for good?')) return;
		setError('');
		Promise.resolve(api('/api/browser/profiles/' + encodeURIComponent(profile.id), { method: 'DELETE' }))
			.then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
			.then(function (res) {
				if (!res.ok) { setError((res.body && res.body.error) || 'Could not delete profile'); return; }
				refresh();
			})
			.catch(function () { setError('Could not delete profile'); });
	}

	// Destructive — DOUBLE confirm. Clears saved logins (cookies + storage) but
	// KEEPS the profile record; enabled for the default profile too (you can log
	// it out without deleting it).
	function clearLogins(profile) {
		if (!window.confirm('Clear all saved logins for "' + profile.name + '"? You will be signed out everywhere in it.')) return;
		if (!window.confirm('This wipes cookies and site data for "' + profile.name + '". Continue?')) return;
		setError('');
		Promise.resolve(api('/api/browser/profiles/' + encodeURIComponent(profile.id) + '/data', { method: 'DELETE' }))
			.then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
			.then(function (res) {
				if (!res.ok) { setError((res.body && res.body.error) || 'Could not clear logins'); return; }
				refresh();
			})
			.catch(function () { setError('Could not clear logins'); });
	}

	// Desktop-only: open a real foreground view on this profile's partition and
	// navigate it so the user signs in by hand; the partition persists the login.
	function loginOnce(profile) {
		var b = bridge();
		if (!b || !b.openProfileView) { setError('Log-in-once is available in the desktop app only'); return; }
		var url = window.prompt('Open which site to log into "' + profile.name + '"?', 'https://');
		if (url == null) return;
		url = url.trim();
		if (!url) return;
		if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
		setError('');
		// Close the manager so the native login view isn't hidden behind the panel.
		close();
		Promise.resolve(b.openProfileView(profile.id, url)).catch(function () { /* nav-state carries outcome */ });
	}

	// ── Render ─────────
	function actionButton(label, title, onClick, disabled) {
		var btn = document.createElement('button');
		btn.className = 'artifact-filter';
		btn.textContent = label;
		if (title) btn.title = title;
		if (disabled) btn.disabled = true;
		else btn.addEventListener('click', onClick);
		return btn;
	}

	function renderRow(profile) {
		var row = document.createElement('div');
		row.className = 'browser-profile-row';
		row.setAttribute('data-profile-id', profile.id);
		row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border)';

		var meta = document.createElement('div');
		meta.style.cssText = 'flex:1;min-width:0';
		var name = document.createElement('div');
		name.className = 'browser-profile-name';
		name.textContent = profile.name;
		name.style.cssText = 'font-size:.72rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
		var sub = document.createElement('div');
		sub.className = 'browser-profile-sub';
		sub.textContent = (profile.id === DEFAULT_ID ? 'Default · ' : '') + 'used ' + relTime(profile.lastUsedAt);
		sub.style.cssText = 'font-size:.62rem;color:var(--text-dim)';
		meta.appendChild(name);
		meta.appendChild(sub);
		row.appendChild(meta);

		row.appendChild(actionButton('Log in once', 'Sign in by hand; the profile keeps the login', function () { loginOnce(profile); }, false));
		row.appendChild(actionButton('Rename', 'Rename this profile', function () { renameProfile(profile); }, false));
		row.appendChild(actionButton('Clear logins', 'Sign out everywhere in this profile', function () { clearLogins(profile); }, false));
		// Delete is refused for the default profile — render it disabled so the
		// protection is visible, not a surprise 409.
		row.appendChild(actionButton('Delete', profile.id === DEFAULT_ID ? "The default profile can't be deleted" : 'Delete this profile', function () { deleteProfile(profile); }, profile.id === DEFAULT_ID));
		return row;
	}

	function render(profiles) {
		var p = panel();
		if (!p) return;
		p.innerHTML = '';

		var head = document.createElement('div');
		head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border)';
		var title = document.createElement('div');
		title.textContent = 'Browser profiles';
		title.style.cssText = 'flex:1;font-size:.74rem;color:var(--text)';
		var closeBtn = actionButton('Close', 'Close profile manager', close, false);
		head.appendChild(title);
		head.appendChild(closeBtn);
		p.appendChild(head);

		var err = document.createElement('div');
		err.id = 'browser-profiles-error';
		err.style.cssText = 'display:none;padding:6px 8px;font-size:.66rem;color:var(--danger,#e5484d)';
		p.appendChild(err);

		var list = document.createElement('div');
		list.id = 'browser-profiles-list';
		for (var i = 0; i < profiles.length; i++) list.appendChild(renderRow(profiles[i]));
		p.appendChild(list);

		// Create form.
		var form = document.createElement('div');
		form.style.cssText = 'display:flex;gap:6px;padding:8px';
		var input = document.createElement('input');
		input.id = 'browser-profiles-name-input';
		input.type = 'text';
		input.placeholder = 'New profile name';
		input.setAttribute('autocomplete', 'off');
		input.style.cssText = 'flex:1;min-width:0;background:transparent;border:1px solid var(--border);color:var(--text);font-size:.68rem;padding:4px 8px;border-radius:4px;outline:none';
		input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); createProfile(); } });
		var createBtn = actionButton('Create', 'Create a new profile', createProfile, false);
		form.appendChild(input);
		form.appendChild(createBtn);
		p.appendChild(form);
	}

	// ── Open / close ─────────
	function open() {
		var p = panel();
		if (!p) return;
		isOpen = true;
		p.style.display = 'block';
		// Nudge browser-tab.js to re-run its occlusion probe so the native view
		// hides behind the now-visible panel.
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

	window.laxBrowserProfiles = {
		toggle: toggle,
		open: open,
		close: close,
		refresh: refresh,
		// Exposed for tests + programmatic use.
		render: render,
		isOpen: function () { return isOpen; },
	};
})();
