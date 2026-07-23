// ── Chat links open in the IN-APP browser pane (desktop only) ──
//
// Left-click on an external http(s) link in a chat message mints a fresh USER
// tab in the Browser panel (window.laxBrowserTab.openUrl) instead of bouncing
// to the system browser; right-click offers a small menu with the external
// escape hatch. In a plain browser (no window.desktop.browser) this module
// no-ops and the default target=_blank behavior stands.
//
// Scope: PUBLIC web links only. Loopback/app-origin links (dev-server
// previews, /files/ downloads, doc links) keep the audited main-process
// window-open path — the in-app pane's egress guard SSRF-blocks loopback, so
// diverting them would render a blocked page instead of the file/app.
// Modified clicks (Ctrl/Cmd/Shift/Alt) also keep the default path.
(function () {
	var bridge = window.desktop && window.desktop.browser;
	if (!bridge || !bridge.newTab) return;

	function inAppUrl(href) {
		try {
			var u = new URL(href, window.location.href);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
			var h = u.hostname.toLowerCase();
			if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1' || h === '0.0.0.0') return null;
			return u.href;
		} catch (e) { return null; }
	}

	function linkFrom(target) {
		var a = target && target.closest ? target.closest('a.md-link') : null;
		if (!a) return null;
		// File links open with the system default app / download flow — not pages.
		if (a.classList.contains('file-download') || a.classList.contains('file-link')) return null;
		return a;
	}

	function openInApp(url) {
		if (window.laxBrowserTab && window.laxBrowserTab.openUrl) window.laxBrowserTab.openUrl(url);
	}

	var messages = document.getElementById('messages');
	if (!messages) return;

	messages.addEventListener('click', function (e) {
		if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
		var a = linkFrom(e.target);
		if (!a) return;
		var url = inAppUrl(a.getAttribute('href') || '');
		if (!url) return;
		e.preventDefault();
		openInApp(url);
	});

	// ── Right-click menu: in app / external / copy ──
	var menu = null;
	function dismiss() { if (menu) { menu.remove(); menu = null; } }
	document.addEventListener('click', dismiss);
	document.addEventListener('contextmenu', function (e) {
		// A right-click anywhere else drops the open menu. The opening event
		// itself bubbles here too — it is the one the link handler below
		// already claimed (preventDefault), so it must not dismiss its own menu.
		if (e.defaultPrevented) return;
		if (menu && !menu.contains(e.target)) dismiss();
	});
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape') dismiss(); });
	window.addEventListener('blur', dismiss);

	function item(label, fn) {
		var d = document.createElement('div');
		d.className = 'link-menu-item';
		d.setAttribute('role', 'menuitem');
		d.textContent = label;
		d.addEventListener('click', function (e) { e.stopPropagation(); dismiss(); fn(); });
		return d;
	}

	messages.addEventListener('contextmenu', function (e) {
		var a = linkFrom(e.target);
		if (!a) return;
		var url = inAppUrl(a.getAttribute('href') || '');
		if (!url) return; // loopback/file links keep the native context menu
		e.preventDefault();
		dismiss();
		menu = document.createElement('div');
		menu.className = 'composer-pop link-menu';
		menu.setAttribute('role', 'menu');
		menu.setAttribute('aria-label', 'Link actions');
		menu.appendChild(item('Open in app browser', function () { openInApp(url); }));
		menu.appendChild(item('Open in external browser', function () {
			// Rides the audited main-process window-open path (shell.openExternal).
			window.open(url, '_blank', 'noopener');
		}));
		menu.appendChild(item('Copy link', function () {
			if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {});
		}));
		document.body.appendChild(menu);
		// Clamp to the viewport so a menu near an edge stays fully visible.
		var x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
		var y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
		menu.style.left = Math.max(8, x) + 'px';
		menu.style.top = Math.max(8, y) + 'px';
	});
})();
