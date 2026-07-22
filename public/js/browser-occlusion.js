// Occlusion probe for the Browser pane's native-view anchor. Extracted from
// browser-tab.js (same split precedent as browser-error-card.js) — that module
// calls window.laxBrowserOcclusion.anchorOccluded from sync(); a page loaded
// without this script treats the anchor as unoccluded.
//
// DOM overlays (global search, shortcuts help, modals, dropdown menus)
// would render UNDER the native view unless it hides — hit-test a probe
// GRID over the anchor: any probe resolving outside the anchor means
// occluded. Fixed probe points (center-only, then center + 4 corners)
// failed twice for the titlebar ⋯ menu — it drapes over the pane's top
// edge but stops short of the inset corner (caption buttons sit to its
// right), so every hand-picked point missed and the menu rendered stuck
// behind the page. The grid makes the guarantee geometric instead:
// perimeter probes every ≤60px catch anything crossing an edge with a
// ≥60px run (dropdowns are ≥180px wide), and a sparse ≤160px interior
// grid catches overlays floating fully inside the pane. ~120 probes for
// a full-height pane, only while the view is visible, rAF-coalesced by
// the caller. The 12px inset keeps edge probes off adjacent chrome (the
// panel resize handle strip); a null hit (no layout info) is treated as
// unoccluded rather than flapping the view off.
(function () {
	function axisStops(from, to, spacing) {
		if (to <= from) return [from];
		var n = Math.max(1, Math.ceil((to - from) / spacing));
		var stops = [];
		for (var i = 0; i <= n; i++) stops.push(from + ((to - from) * i) / n);
		return stops;
	}

	function anchorOccluded(anchor, rect) {
		if (typeof document.elementFromPoint !== 'function') return false;
		var inset = 12;
		var x0 = rect.left + inset, x1 = rect.left + rect.width - inset;
		var y0 = rect.top + inset, y1 = rect.top + rect.height - inset;
		var xs = axisStops(x0, x1, 60);
		var ys = axisStops(y0, y1, 60);
		var points = [];
		var i, j;
		for (i = 0; i < xs.length; i++) points.push([xs[i], y0], [xs[i], y1]);
		for (j = 1; j < ys.length - 1; j++) points.push([x0, ys[j]], [x1, ys[j]]);
		var xsIn = axisStops(x0, x1, 160);
		var ysIn = axisStops(y0, y1, 160);
		for (i = 1; i < xsIn.length - 1; i++) {
			for (j = 1; j < ysIn.length - 1; j++) points.push([xsIn[i], ysIn[j]]);
		}
		for (i = 0; i < points.length; i++) {
			var hit = document.elementFromPoint(points[i][0], points[i][1]);
			if (hit && hit !== anchor && !anchor.contains(hit) && !(document.body.classList.contains('browser-workspace') && hit.closest && hit.closest('#chat-main'))) return true;
		}
		return false;
	}

	window.laxBrowserOcclusion = {
		anchorOccluded: anchorOccluded,
	};
})();
