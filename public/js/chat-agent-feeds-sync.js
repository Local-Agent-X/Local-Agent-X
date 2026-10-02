// ── Agent Feeds — 1s sync tick ──
// Re-applies the visible DOM of every live record from agentFeedsData:
// the row cells the jobs layout owns (elapsed time, tokens, stall badge) and
// the embedded detail (latest line, activity trace, stream text).
// updateAgentFeed already writes most of this per event; the tick is the
// safety net for the paint hiccups field reports kept showing (a count or
// latest line freezing until a chat switch forced a full re-render), and it
// is the only thing that advances the elapsed clocks. textContent writes
// only, never an innerHTML rebuild, so a user's scroll and fold survive.
//
// Loads after chat-agent-feeds.js; reads its globals at tick time.

function syncAgentRowCells(id, rec, now) {
  var row = document.getElementById('agent-row-' + id);
  if (!row) return;
  var timeEl = row.querySelector('.job-row-time');
  var time = jobRowTimeLabel(rec, now);
  if (timeEl && timeEl.textContent !== time) timeEl.textContent = time;
  var tokEl = row.querySelector('.job-row-tokens');
  if (tokEl) {
    var tok = Number(rec.totalTokens) > 0 ? formatTokens(rec.totalTokens) : '';
    if (tokEl.textContent !== tok) tokEl.textContent = tok;
  }
  var modelEl = row.querySelector('.job-row-model');
  if (modelEl && rec.model && modelEl.textContent !== rec.model) modelEl.textContent = rec.model;
  // A stall appears or clears between events; a task card's Cancel button
  // comes and goes with it, so that is a rebuild, not a class flip.
  var stalled = jobStallMs(rec, now) > 0;
  if (row.classList.contains('stalled') !== stalled) _renderAgentFeedsList();
}

function syncAgentCardBody(id, rec) {
  var card = document.getElementById('agent-card-' + id);
  if (!card) return;
  var output = rec.output || '';
  var lines = output.split('\n').filter(function(l) { return l.trim().length > 0; });
  var countEl = card.querySelector('.worker-tools-count');
  if (countEl && countEl.textContent !== String(lines.length)) countEl.textContent = String(lines.length);
  var latestEl = card.querySelector('.worker-latest');
  var latest = lines.length > 0 ? lines[lines.length - 1] : null;
  if (latestEl && latest != null && latestEl.textContent !== latest) latestEl.textContent = latest;
  var toolsBody = card.querySelector('.worker-tools-body');
  if (toolsBody && toolsBody.textContent !== output) {
    var atBottomT = (toolsBody.scrollHeight - toolsBody.scrollTop - toolsBody.clientHeight) < 40;
    toolsBody.textContent = output;
    if (atBottomT) toolsBody.scrollTop = toolsBody.scrollHeight;
  }
  if (rec.streamText) {
    var textEl = card.querySelector('.worker-text');
    if (textEl && textEl.textContent !== rec.streamText) {
      var atBottom = (textEl.scrollHeight - textEl.scrollTop - textEl.clientHeight) < 40;
      textEl.textContent = rec.streamText;
      if (atBottom) textEl.scrollTop = textEl.scrollHeight;
    }
  }
}

// Job headers tick too: the elapsed clock on a running job's head row.
function syncJobHeads(now) {
  var heads = document.querySelectorAll('.job:not(.finished) .job-head[data-agent-row]');
  for (var i = 0; i < heads.length; i++) {
    var rec = agentFeedsData[heads[i].getAttribute('data-agent-row')];
    var el = heads[i].querySelector('.job-head-time');
    if (!rec || !el) continue;
    var t = jobElapsedLabel(rec.startedAt, 0, now);
    if (el.textContent !== t) el.textContent = t;
  }
}

setInterval(function() {
  var now = Date.now();
  var ids = Object.keys(agentFeedsData);
  for (var i = 0; i < ids.length; i++) {
    var rec = agentFeedsData[ids[i]];
    if (!rec || isTerminalStatus(rec.status)) continue;
    syncAgentRowCells(ids[i], rec, now);
    syncAgentCardBody(ids[i], rec);
  }
  syncJobHeads(now);
}, 1000);
