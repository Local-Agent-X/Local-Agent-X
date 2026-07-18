// Tab strip for the Browser panel. browser-tab.js delegates strip rendering
// and selection reconciliation here (loaded just before it from app.html).
//
//   render(views, opts)  — one pill per pool view in
//     #browser-view-switcher-slot, ALWAYS (even with a single view), plus a
//     "+" new-tab button at the end. Pill label: page title, else URL host,
//     else profileId, else "tab"; 🤖 prefix on agent-driven views; the active
//     pill is the SELECTED (attached) view.
//   reconcileSelection(views, selectedViewId) — main may retarget the shown
//     view itself (auto-surface of an agent view). If listViews() reports an
//     attached view that differs from the renderer's selection, the renderer
//     must re-adopt it — otherwise the address bar + active pill keep naming
//     the old view while back/forward/reload drive the one on screen. Returns
//     the view entry to adopt, or null when the selection is already right.
//     (When nothing is attached — tab hidden — the selection is left alone;
//     showing the tab attaches the current view and the next views-changed
//     poke reconciles.)
//
// Close affordance: a ✕ rides each USER pill (agentDriven === false) and calls
// opts.onClose(viewId). It mirrors the server bridge's close guard — the bridge
// closes only agent views (its own), so the renderer closes only user views.
// Agent 🤖 pills get NO ✕: closing one out from under a running agent would
// break its browsing with no recovery, so those stay agent-managed.
(function () {
	function hostOf(url) {
		if (!url) return '';
		try { return new URL(url).host; } catch (e) { return ''; }
	}

	function stripLabel(v) {
		var name = (v.title && String(v.title).trim()) || hostOf(v.url) || v.profileId || 'tab';
		return (v.agentDriven ? '🤖 ' : '') + name;
	}

	function reconcileSelection(views, selectedViewId) {
		if (!views || !views.length) return null;
		var attached = null;
		for (var i = 0; i < views.length; i++) {
			if (views[i].attached) { attached = views[i]; break; }
		}
		// First paint: adopt the attached view, else the first listed.
		if (selectedViewId == null) return attached || views[0];
		// Auto-surface / attach flip: follow the view actually on screen.
		if (attached && attached.viewId !== selectedViewId) return attached;
		return null;
	}

	// opts: { slot, selectedViewId, onSelect(viewId), onNewTab(), onClose(viewId) }
	function render(views, opts) {
		var slot = opts && opts.slot;
		if (!slot) return;
		views = views || [];
		slot.innerHTML = '';
		for (var i = 0; i < views.length; i++) {
			(function (v) {
				var pill = document.createElement('button');
				pill.className = 'browser-strip-tab' +
					(v.viewId === opts.selectedViewId ? ' active' : '');
				pill.title = v.viewId + (v.url ? ('\n' + v.url) : '') +
					(v.agentDriven ? '\n(agent-driven)' : '');
				pill.setAttribute('data-view-id', v.viewId);
				pill.setAttribute('role', 'tab');
				pill.setAttribute('aria-selected', v.viewId === opts.selectedViewId ? 'true' : 'false');
				var name = document.createElement('span');
				name.className = 'browser-tab-label';
				name.textContent = stripLabel(v);
				pill.appendChild(name);
				pill.addEventListener('click', function () {
					if (opts.onSelect) opts.onSelect(v.viewId);
				});
				// Only user views are closable (agent 🤖 views are agent-managed).
				if (!v.agentDriven && opts.onClose) {
					var x = document.createElement('span');
					x.className = 'browser-tab-close';
					x.textContent = '✕';
					x.setAttribute('data-close-view-id', v.viewId);
					x.title = 'Close tab';
					x.addEventListener('click', function (e) {
						// Don't let the close bubble into pill select.
						e.stopPropagation();
						opts.onClose(v.viewId);
					});
					pill.appendChild(x);
				}
				slot.appendChild(pill);
			})(views[i]);
		}
		var plus = document.createElement('button');
		plus.className = 'browser-new-tab';
		plus.textContent = '+';
		plus.title = 'New tab';
		plus.setAttribute('data-strip-new-tab', '');
		plus.addEventListener('click', function () {
			if (opts.onNewTab) opts.onNewTab();
		});
		slot.appendChild(plus);
	}

	window.laxBrowserTabStrip = {
		label: stripLabel,
		reconcileSelection: reconcileSelection,
		render: render,
	};
})();
