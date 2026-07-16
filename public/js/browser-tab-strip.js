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
// No ✕ close affordance: the desktop preload exposes no renderer-side close
// channel for views (server-side closes of user views are refused; agent
// views are the agent's) — parked until a close channel exists.
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

	// opts: { slot, selectedViewId, onSelect(viewId), onNewTab() }
	function render(views, opts) {
		var slot = opts && opts.slot;
		if (!slot) return;
		views = views || [];
		slot.innerHTML = '';
		slot.style.display = 'flex';
		slot.style.gap = '4px';
		for (var i = 0; i < views.length; i++) {
			(function (v) {
				var pill = document.createElement('button');
				pill.className = 'artifact-filter' +
					(v.viewId === opts.selectedViewId ? ' active' : '');
				pill.textContent = stripLabel(v);
				pill.title = v.viewId + (v.url ? ('\n' + v.url) : '') +
					(v.agentDriven ? '\n(agent-driven)' : '');
				pill.setAttribute('data-view-id', v.viewId);
				pill.addEventListener('click', function () {
					if (opts.onSelect) opts.onSelect(v.viewId);
				});
				slot.appendChild(pill);
			})(views[i]);
		}
		var plus = document.createElement('button');
		plus.className = 'artifact-filter';
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
