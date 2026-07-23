// Downloads panel — Chrome-style downloads list behind the "Downloads" button
// in the right-panel Browser tab (#browser-downloads-panel). Same overlay/
// occlusion contract as browser-library.js: toggling display pokes
// laxBrowserTab.sync() so the native WebContentsView hides under the panel.
//
// Data comes over the desktop bridge (window.desktop.browser.listDownloads):
// USER-routed downloads (~/Downloads; Open / Show in Folder) plus a read-only
// list of agent-QUARANTINED entries so a download that "went nowhere" is
// explained here instead of vanishing. Polls 1s while open for live progress.
// Plain browser (no bridge): the button hides itself, everything no-ops.

(function () {
	var POLL_MS = 1000;
	var bridge = (window.desktop && window.desktop.browser) || null;

	function panel() { return document.getElementById('browser-downloads-panel'); }

	var isOpen = false;
	var pollTimer = null;

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	function fmtBytes(n) {
		if (!(n > 0)) return '';
		if (n < 1024) return n + ' B';
		if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
		if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
		return (n / 1073741824).toFixed(2) + ' GB';
	}

	function relTime(ts) {
		if (!ts) return '';
		var d = Date.now() - ts;
		if (d < 60000) return 'just now';
		if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
		if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
		try { return new Date(ts).toLocaleDateString(); } catch (e) { return ''; }
	}

	function statusLine(e) {
		if (e.state === 'progressing') {
			var pct = e.totalBytes > 0 ? Math.floor((e.bytes / e.totalBytes) * 100) + '%' : fmtBytes(e.bytes);
			return 'Downloading… ' + pct;
		}
		if (e.state === 'completed') return fmtBytes(e.totalBytes || e.bytes) + ' · ' + relTime(e.doneAt || e.startedAt);
		return e.state; // cancelled / interrupted — say it plainly
	}

	var ROW_STYLE = 'display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border)';
	var NAME_STYLE = 'font-size:.7rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
	var SUB_STYLE = 'font-size:.62rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

	function userRow(e) {
		var done = e.state === 'completed';
		return '<div class="dl-row" data-id="' + esc(e.id) + '" style="' + ROW_STYLE + '">'
			+ '<div style="flex:1;min-width:0"><div title="' + esc(e.savePath) + '" style="' + NAME_STYLE + '">' + esc(e.filename) + '</div>'
			+ '<div style="' + SUB_STYLE + '">' + esc(statusLine(e)) + '</div></div>'
			+ (done ? '<button class="artifact-filter dl-open">Open</button>' : '')
			+ (done ? '<button class="artifact-filter dl-reveal">Show in Folder</button>' : '')
			+ '</div>';
	}

	function quarantinedRow(e) {
		return '<div class="dl-row" style="' + ROW_STYLE + ';opacity:.75">'
			+ '<div style="flex:1;min-width:0"><div style="' + NAME_STYLE + '">' + esc(e.filename) + '</div>'
			+ '<div style="' + SUB_STYLE + '">quarantined (agent download' + (e.state === 'progressing' ? ', in flight' : '') + ') — '
			+ 'released only through the agent with your approval</div></div>'
			+ '</div>';
	}

	function render(data) {
		var p = panel();
		if (!p || !isOpen) return;
		var user = (data && data.user) || [];
		var quarantined = (data && data.quarantined) || [];
		var html = '<div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border)">'
			+ '<div style="flex:1;font-size:.74rem;color:var(--text)">Downloads</div>'
			+ '<button class="artifact-filter" id="dl-close">Close</button></div>';
		if (user.length === 0 && quarantined.length === 0) {
			html += '<div class="artifacts-empty">No downloads this session. Files you download land in your Downloads folder.</div>';
		} else {
			html += user.map(userRow).join('');
			if (quarantined.length) {
				html += '<div style="padding:8px;font-size:.66rem;color:var(--muted);border-bottom:1px solid var(--border)">Agent downloads (quarantined)</div>'
					+ quarantined.map(quarantinedRow).join('');
			}
		}
		p.innerHTML = html;
	}

	function refresh() {
		if (!bridge || !bridge.listDownloads) return;
		Promise.resolve(bridge.listDownloads()).then(render).catch(function () { /* bridge gone — next poll retries */ });
	}

	function setOpen(open) {
		var p = panel();
		if (!p || !bridge) return;
		isOpen = open;
		p.style.display = open ? '' : 'none';
		// Occlusion contract: the native view must hide under the panel.
		if (window.laxBrowserTab && window.laxBrowserTab.sync) window.laxBrowserTab.sync();
		if (open) {
			refresh();
			if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
		} else if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function init() {
		var btn = document.getElementById('browser-downloads-btn');
		if (!bridge || !bridge.listDownloads) {
			if (btn) btn.style.display = 'none';
			return;
		}
		var p = panel();
		if (p) {
			p.addEventListener('click', function (e) {
				var t = e.target;
				if (!t || !t.classList) return;
				if (t.id === 'dl-close') { setOpen(false); return; }
				var row = t.closest ? t.closest('.dl-row') : null;
				var id = row && row.getAttribute('data-id');
				if (!id) return;
				if (t.classList.contains('dl-open') && bridge.openDownload) bridge.openDownload(id);
				if (t.classList.contains('dl-reveal') && bridge.revealDownload) bridge.revealDownload(id);
			});
		}
	}

	window.laxBrowserDownloads = {
		toggle: function () { setOpen(!isOpen); },
		isOpen: function () { return isOpen; },
		refresh: refresh,
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init, { once: true });
	} else {
		init();
	}
})();
