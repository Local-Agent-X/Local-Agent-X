// Tab strip for the Browser panel. browser-tab.js delegates strip rendering
// and selection reconciliation here (loaded just before it from app.html).
//
//   render(views, opts)  — one pill per pool view in
//     #browser-view-switcher-slot, ALWAYS (even with a single view), plus a
//     "+" new-tab button at the end. Pill label: page title, else URL host,
//     else profileId, else "tab"; app-mark icon on agent-driven views; the active
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
// Close affordance: a ✕ rides EVERY pill (when the bridge can close) and calls
// opts.onClose(viewId). Agent views close recoverably: main notifies the
// server child, whose backend marks the tab gone and recreates the view on
// the agent's next op — so the user can always dismiss a lingering agent tab.
//
// Drag-reorder: pills are draggable; dropping persists the viewId order to
// localStorage and render() applies it as a sort. Ordering is a PRESENTATION
// preference of this strip only — main's pool order stays canonical (the
// server's tabs listing reads it), which is why nothing crosses the bridge.
// Saving the full current order on each drop prunes stale session viewIds.
(function () {
	function hostOf(url) {
		if (!url) return '';
		try { return new URL(url).host; } catch (e) { return ''; }
	}

	var ORDER_KEY = 'laxBrowserTabOrder';

	function loadOrder() {
		try {
			var arr = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
			return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string'; }) : [];
		} catch (e) { return []; }
	}

	function saveOrder(ids) {
		try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch (e) { /* storage unavailable */ }
	}

	/** Stable sort: known viewIds take their saved position, newcomers keep
	 *  their pool order after the known ones. */
	function applyOrder(views, order) {
		return views
			.map(function (v, i) {
				var at = order.indexOf(v.viewId);
				return { v: v, key: at < 0 ? order.length + i : at };
			})
			.sort(function (a, b) { return a.key - b.key; })
			.map(function (x) { return x.v; });
	}

	// One dragged pill at a time; reorder live on dragover, persist on dragend.
	var draggedPill = null;

	function wireDragReorder(slot) {
		if (slot.dataset.dragReorderWired) return;
		slot.dataset.dragReorderWired = '1';
		slot.addEventListener('dragover', function (e) {
			if (!draggedPill) return;
			e.preventDefault(); // required for the move drop-cursor
			var over = e.target && e.target.closest ? e.target.closest('.browser-strip-tab') : null;
			if (!over || over === draggedPill || over.parentNode !== slot) return;
			var rect = over.getBoundingClientRect();
			var before = e.clientX < rect.left + rect.width / 2;
			slot.insertBefore(draggedPill, before ? over : over.nextSibling);
		});
		slot.addEventListener('drop', function (e) {
			if (draggedPill) e.preventDefault();
		});
	}

	function stripLabel(v) {
		return (v.title && String(v.title).trim()) || hostOf(v.url) || v.profileId || 'tab';
	}

	// Per-view loading state (viewId → true), fed by browser-tab.js from tagged
	// nav-state pushes (noteNavState below). Presentation-only, like the drag
	// order — render() paints it and prunes ids that left the pool; noteNavState
	// pokes the live pill between renders so the spinner tracks did-start/
	// did-stop-loading without waiting for the next poll.
	var loadingViews = {};

	/** Track a tagged nav-state push: spin the pill of a loading view, clear it
	 *  on load end AND on a load failure (a dead pill must not spin forever). */
	function noteNavState(state) {
		if (!state || !state.viewId) return;
		var isLoading = !!state.loading && !state.loadError;
		if (isLoading) loadingViews[state.viewId] = true;
		else delete loadingViews[state.viewId];
		var pills = document.querySelectorAll('.browser-strip-tab[data-view-id]');
		for (var i = 0; i < pills.length; i++) {
			// Attribute compare instead of a selector interpolation — viewIds are
			// not guaranteed selector-safe.
			if (pills[i].getAttribute('data-view-id') !== state.viewId) continue;
			if (isLoading) pills[i].classList.add('loading');
			else pills[i].classList.remove('loading');
		}
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
		views = applyOrder(views || [], loadOrder());
		wireDragReorder(slot);
		draggedPill = null; // a re-render mid-drag orphans the dragged node
		// Prune loading state for views that left the pool — a reused viewId
		// (foreground recreated) must not inherit a stale spinner.
		var live = {};
		for (var k = 0; k < views.length; k++) live[views[k].viewId] = true;
		for (var id in loadingViews) { if (!live[id]) delete loadingViews[id]; }
		slot.innerHTML = '';
		for (var i = 0; i < views.length; i++) {
			(function (v) {
				var pill = document.createElement('button');
				pill.className = 'browser-strip-tab' +
					(v.viewId === opts.selectedViewId ? ' active' : '') +
					(loadingViews[v.viewId] ? ' loading' : '');
				pill.title = v.viewId + (v.url ? ('\n' + v.url) : '') +
					(v.agentDriven ? '\n(agent-driven)' : '');
				pill.setAttribute('data-view-id', v.viewId);
				pill.setAttribute('role', 'tab');
				pill.setAttribute('aria-selected', v.viewId === opts.selectedViewId ? 'true' : 'false');
				if (v.agentDriven) {
					var mark = document.createElement('img');
					mark.className = 'browser-tab-agent-icon';
					mark.src = '/favicon.png';
					mark.alt = 'Agent';
					pill.appendChild(mark);
				}
				// Spinner rides EVERY pill (hidden by CSS unless .loading) so the
				// nav-state poke only has to toggle a class, never build DOM.
				var spin = document.createElement('span');
				spin.className = 'browser-tab-spinner';
				spin.setAttribute('aria-hidden', 'true');
				pill.appendChild(spin);
				var name = document.createElement('span');
				name.className = 'browser-tab-label';
				name.textContent = stripLabel(v);
				pill.appendChild(name);
				pill.addEventListener('click', function () {
					if (opts.onSelect) opts.onSelect(v.viewId);
				});
				pill.draggable = true;
				pill.addEventListener('dragstart', function (e) {
					draggedPill = pill;
					pill.classList.add('dragging');
					if (e.dataTransfer) {
						e.dataTransfer.effectAllowed = 'move';
						try { e.dataTransfer.setData('text/plain', v.viewId); } catch (err) { /* jsdom */ }
					}
				});
				pill.addEventListener('dragend', function () {
					pill.classList.remove('dragging');
					if (!draggedPill) return; // a re-render already invalidated this drag
					draggedPill = null;
					var ids = [];
					var ordered = slot.querySelectorAll('.browser-strip-tab[data-view-id]');
					for (var j = 0; j < ordered.length; j++) ids.push(ordered[j].getAttribute('data-view-id'));
					saveOrder(ids);
				});
				if (opts.onClose) {
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
		applyOrder: applyOrder,
		noteNavState: noteNavState,
	};
})();
