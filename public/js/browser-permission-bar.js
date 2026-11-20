// Permission bar for the Browser pane. When a page in a pane tab asks for
// something the desktop blocks quietly (storage access: an embedded chat
// window, video or sign-in box asking to remember you), main pushes a notice
// tagged with the tab's viewId instead of opening a modal
// (desktop/src/browser-permission-bar-ipc.ts). This module shows it as a row
// with Allow and Dismiss, so nothing is blocked where the user cannot see it.
//
//   - A NORMAL-FLOW row inserted before #browser-view-anchor, like the find
//     bar (browser-find.js): the page is a native view painted above all DOM,
//     so a row that overlaid it would be invisible and would trip the
//     occlusion probe. A flow row shrinks the anchor and browser-tab.js's
//     ResizeObserver re-reports the rect.
//   - Notices are kept per tab and shown for the selected tab only
//     (browser-tab.js calls onViewSelected). A tab that moves to another site
//     drops its notices: they were about the page it left.
//   - The sentence comes from main, worded with the modal's text, so the two
//     never say different things.
//   - Allow asks main to grant that one origin+permission and reload the tab.
//
// Plain browser (no window.desktop.browser): every entry point no-ops.
(function () {
	var bridge = (window.desktop && window.desktop.browser) || null;
	var supported = !!(bridge && bridge.onPermissionBlocked && bridge.allowPermission);
	var noticesByView = {}; // viewId -> [{ origin, permission, text }]
	var siteByView = {};    // viewId -> origin of the page the notices were about
	var selectedViewId = null;

	function keyOf(n) { return n.origin + '|' + n.permission; }

	function originOf(url) {
		try { return new URL(url).origin; } catch (e) { return ''; }
	}

	function ensureBar() {
		var el = document.getElementById('browser-permission-bar');
		if (el) return el;
		var body = document.getElementById('browser-tab-body');
		var anchor = document.getElementById('browser-view-anchor');
		if (!body || !anchor) return null;
		el = document.createElement('div');
		el.id = 'browser-permission-bar';
		el.className = 'browser-permission-bar';
		el.setAttribute('role', 'status');
		el.style.display = 'none';
		body.insertBefore(el, anchor);
		return el;
	}

	function remove(viewId, notice) {
		var list = noticesByView[viewId] || [];
		noticesByView[viewId] = list.filter(function (n) { return keyOf(n) !== keyOf(notice); });
		render();
	}

	function row(viewId, notice) {
		var r = document.createElement('div');
		r.className = 'browser-permission-row';
		var text = document.createElement('span');
		text.className = 'browser-permission-text';
		text.textContent = 'Blocked: ' + notice.text;
		var allow = document.createElement('button');
		allow.className = 'artifact-filter';
		allow.textContent = 'Allow';
		allow.title = 'Allow it for this site and reload the page';
		allow.addEventListener('click', function () {
			allow.disabled = true;
			Promise.resolve(bridge.allowPermission(viewId, notice.origin, notice.permission)).then(function (ok) {
				if (ok) remove(viewId, notice);
				else allow.disabled = false;
			}).catch(function () { allow.disabled = false; });
		});
		var dismiss = document.createElement('button');
		dismiss.className = 'artifact-filter';
		dismiss.textContent = '✕';
		dismiss.title = 'Keep it blocked and close this message';
		dismiss.setAttribute('aria-label', 'Dismiss');
		dismiss.addEventListener('click', function () { remove(viewId, notice); });
		r.appendChild(text);
		r.appendChild(allow);
		r.appendChild(dismiss);
		return r;
	}

	function render() {
		var list = (selectedViewId && noticesByView[selectedViewId]) || [];
		var el = list.length ? ensureBar() : document.getElementById('browser-permission-bar');
		if (!el) return;
		el.textContent = '';
		for (var i = 0; i < list.length; i++) el.appendChild(row(selectedViewId, list[i]));
		el.style.display = list.length ? '' : 'none';
	}

	function onBlocked(notice) {
		if (!notice || !notice.viewId) return;
		var list = noticesByView[notice.viewId] || (noticesByView[notice.viewId] = []);
		// A page asks again on every load; one row per origin+permission.
		for (var i = 0; i < list.length; i++) if (keyOf(list[i]) === keyOf(notice)) return;
		list.push({ origin: notice.origin, permission: notice.permission, text: notice.text });
		if (notice.viewId === selectedViewId) render();
	}

	function onNavState(state) {
		if (!state || !state.viewId) return;
		var site = originOf(state.url || '');
		var was = siteByView[state.viewId];
		siteByView[state.viewId] = site;
		if (was && site && was !== site && noticesByView[state.viewId]) {
			delete noticesByView[state.viewId];
			if (state.viewId === selectedViewId) render();
		}
	}

	function onViewSelected(viewId) {
		if (!viewId || viewId === selectedViewId) return;
		selectedViewId = viewId;
		render();
	}

	function init() {
		if (!supported) return;
		bridge.onPermissionBlocked(onBlocked);
		if (bridge.onNavState) bridge.onNavState(onNavState);
	}

	window.laxBrowserPermissionBar = { onViewSelected: onViewSelected };

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init, { once: true });
	} else {
		init();
	}
})();
