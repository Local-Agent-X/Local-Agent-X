// ── Side panel: Overview ──
//
// The right panel's first view: what the chat on screen is doing now (its
// live build or job), its project's plan and spec to read, how much of its
// context is used, and its background work. A summary over what other parts
// already keep, so it adds no state of its own beyond the open document:
//   agentFeedsData / visibleAgentFeeds   chat-agent-feeds*.js
//   window.lastContextStatus             chat-status-bar-indicators.js
//   GET /api/session-folder/docs, /doc   src/routes/session-folder.ts
// A document opens here, rendered with md() (shared.js), with a way back. A
// build wrote its spec and plan and the owner had no way to read them but to
// ask (2026-11-25).
//
// Pure HTML: overviewHtml(view), overviewDocHtml(doc). External deps at call
// time: esc, md, apiJson (shared.js), activeChat, isTerminalStatus,
// formatTokens, jobElapsedLabel (chat-agent-feeds*.js).

var OVERVIEW_REFRESH_MS = 2000;
var OVERVIEW_DOCS_TTL_MS = 15000;
// The documents a /greenfield project's owner reads first, in this order.
var OVERVIEW_DOC_ORDER = ['spec/plan.md', 'spec/product.md', 'spec/constitution.md', 'spec/ledger.md', 'spec/build-state.md'];

var overviewState = { chatId: '', docs: [], docsAt: 0, doc: null, timer: 0 };

function overviewLabel(rec) {
  return String((rec && (rec.name || rec.id)) || '').replace(/^Worker: /, '');
}

// Pure: the chat's live work. `now`: the root job still running (a build, a
// delegated task), with the worker it is on; `background`: every live record.
function overviewWork(feeds, now) {
  var ids = Object.keys(feeds || {});
  var live = ids.map(function (id) { return feeds[id]; }).filter(function (r) { return r && !isTerminalStatus(r.status); });
  var roots = live.filter(function (r) { return !r.parentOpId || !feeds[r.parentOpId]; });
  var root = roots[0] || null;
  var worker = root ? live.filter(function (r) { return r.parentOpId === root.id; }).sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); })[0] : null;
  var tokens = 0;
  if (root) for (var i = 0; i < ids.length; i++) {
    var r = feeds[ids[i]];
    if (r && (r.id === root.id || r.parentOpId === root.id)) tokens += Number(r.totalTokens) || 0;
  }
  return {
    now: root ? { title: overviewLabel(root), on: worker ? overviewLabel(worker) : '', elapsed: jobElapsedLabel(root.startedAt, 0, now), tokens: tokens } : null,
    background: live.map(function (r) { return { id: r.id, title: overviewLabel(r), status: r.status }; }),
  };
}

// Pure: the documents in reading order: the known ones first, then the rest by name.
function overviewSortDocs(docs) {
  var rank = function (p) { var i = OVERVIEW_DOC_ORDER.indexOf(p); return i < 0 ? OVERVIEW_DOC_ORDER.length : i; };
  return (docs || []).slice().sort(function (a, b) { return rank(a.path) - rank(b.path) || String(a.path).localeCompare(String(b.path)); });
}

function overviewSection(label, body) {
  return '<div class="overview-section"><div class="overview-label">' + esc(label) + '</div>' + body + '</div>';
}

// Pure: the Overview. `view` = { work, docs, context }.
function overviewHtml(view) {
  var v = view || {};
  var w = v.work || { now: null, background: [] };
  var now = w.now
    ? '<div class="overview-now-title">' + esc(w.now.title) + '</div>' +
      (w.now.on ? '<div class="overview-muted">' + esc(w.now.on) + '</div>' : '') +
      '<div class="overview-muted">' + esc(w.now.elapsed) + (w.now.tokens > 0 ? ' · ' + esc(formatTokens(w.now.tokens)) + ' tokens' : '') + '</div>'
    : '<div class="overview-muted">Nothing running in this chat</div>';
  var docs = overviewSortDocs(v.docs);
  var docList = docs.length
    ? docs.map(function (d) {
        return '<button type="button" class="overview-doc" data-overview-doc="' + esc(d.path) + '" title="Read ' + esc(d.path) + '">' +
          '<span class="overview-doc-name">' + esc(d.path) + '</span></button>';
      }).join('')
    : '<div class="overview-muted">No plan or spec in this chat\'s project yet</div>';
  var c = v.context;
  var context = c && c.maxTokens
    ? '<div class="overview-row"><span>' + Math.round(c.percentage || 0) + '% used</span><span class="overview-muted">' +
        esc(formatTokens(c.usedTokens || 0)) + ' / ' + esc(formatTokens(c.maxTokens)) + '</span></div>' +
      '<div class="overview-bar"><i style="width:' + Math.min(100, Math.max(0, Math.round(c.percentage || 0))) + '%"></i></div>'
    : '<div class="overview-muted">Not measured yet</div>';
  var bg = w.background.length
    ? w.background.slice(0, 8).map(function (b) {
        return '<div class="overview-row" data-overview-job="' + esc(b.id) + '"><span class="overview-dot"></span><span class="overview-bg-title">' + esc(b.title) + '</span></div>';
      }).join('')
    : '<div class="overview-muted">No background work</div>';
  return overviewSection('Now', now) + overviewSection('Plan and spec', docList) + overviewSection('Context', context) + overviewSection('Background', bg);
}

// Pure: one document, rendered, with the way back.
function overviewDocHtml(doc) {
  return '<div class="overview-doc-head"><button type="button" class="artifact-filter" data-overview-back>&#8592; Overview</button>' +
    '<span class="overview-doc-path">' + esc(doc.path) + '</span></div>' +
    '<div class="overview-doc-body chat-md">' + (doc.text == null ? '<div class="overview-muted">Could not read this document</div>' : md(doc.text)) + '</div>';
}

function overviewChatId() {
  try { return (typeof activeChat !== 'undefined' && activeChat && activeChat.id) || ''; } catch (e) { return ''; }
}

async function overviewLoadDocs(force) {
  var chatId = overviewChatId();
  if (!chatId) { overviewState.docs = []; return; }
  if (!force && overviewState.chatId === chatId && Date.now() - overviewState.docsAt < OVERVIEW_DOCS_TTL_MS) return;
  overviewState.chatId = chatId;
  overviewState.docsAt = Date.now();
  try {
    var data = await apiJson('/api/session-folder/docs?session=' + encodeURIComponent(chatId));
    if (overviewChatId() === chatId) overviewState.docs = (data && Array.isArray(data.docs)) ? data.docs : [];
  } catch (e) { overviewState.docs = []; }
}

async function overviewOpenDoc(path) {
  var chatId = overviewChatId();
  var text = null;
  try {
    var data = await apiJson('/api/session-folder/doc?session=' + encodeURIComponent(chatId) + '&path=' + encodeURIComponent(path));
    text = data && typeof data.text === 'string' ? data.text : null;
  } catch (e) { /* shown as unreadable */ }
  overviewState.doc = { path: path, text: text };
  renderOverview();
}

function renderOverview() {
  var body = document.getElementById('overview-content');
  if (!body) return;
  if (overviewState.doc) { body.innerHTML = overviewDocHtml(overviewState.doc); return; }
  var feeds = typeof visibleAgentFeeds === 'function' ? visibleAgentFeeds() : (typeof agentFeedsData !== 'undefined' ? agentFeedsData : {});
  body.innerHTML = overviewHtml({ work: overviewWork(feeds, Date.now()), docs: overviewState.docs, context: window.lastContextStatus || null });
}

window.laxOverview = {
  onTabShown: function () {
    overviewLoadDocs(false).then(renderOverview);
    renderOverview();
    if (!overviewState.timer) overviewState.timer = setInterval(renderOverview, OVERVIEW_REFRESH_MS);
  },
  onTabHidden: function () {
    if (overviewState.timer) { clearInterval(overviewState.timer); overviewState.timer = 0; }
  },
  onChatChanged: function () {
    overviewState.doc = null;
    if (overviewState.timer) overviewLoadDocs(true).then(renderOverview);
  },
};

if (typeof document !== 'undefined') {
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var docBtn = t.closest('[data-overview-doc]');
    if (docBtn) { overviewOpenDoc(docBtn.getAttribute('data-overview-doc')); return; }
    if (t.closest('[data-overview-back]')) { overviewState.doc = null; renderOverview(); return; }
    var job = t.closest('[data-overview-job]');
    if (job && typeof openClaimJob === 'function') openClaimJob(job.getAttribute('data-overview-job'));
  });
}
