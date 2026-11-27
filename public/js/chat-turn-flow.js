// ── Chat: where a reply's tool calls go, and what it is doing now ──
//
// A long reply used to draw all of its text first and every tool call after
// it, in one "Agent activity" box: on a turn of 110 calls the newest narration
// sat at the top, above a box of everything ever run, and nothing at the bottom
// said what was happening (a 9-minute silent scenario judge read as a frozen
// chat, 2026-11-23). Now the reply reads top to bottom in time order: each
// stretch of calls between two pieces of text is its own collapsed group, at
// the point it ran, and a running reply ends with one line naming the call in
// flight and how long it has run.
//
// Segments. Segment k is everything after the k-th piece of visible text (or
// a message the user sent mid-turn), up to the next one; segment 0 is before
// any. Thinking does not break a segment: it folds into one row ahead of the
// segment's calls. A call's segment is read off the timeline block it came
// after (`afterBlock`, stamped by chat-stream-reducer.js at tool_start). A
// call with no stamp (a row saved before it existed, or a replay, which sends
// its tool events after the text) goes in the last segment: the old layout.
//
// Each group reads as one line of text, "Read 2 files, searched 3 times, ran 1
// command ›", that opens to its calls: the owner asked for text you click, not
// a bordered "Agent activity" bar (2026-11-27). And a running reply ends with
// one status line for the whole turn, "Running: npm test (14s) · 2m 10s ·
// ↓ ~2.3k tokens", or Thinking / Writing between calls, so a reply that is
// working never looks like it is doing nothing.
//
// Exposes (global): isSegmentBreak, toolSegmentsOf, renderTurnNow, formatElapsed,
//   activitySummaryOf, turnTokenEstimate
// External deps (resolved at call time): toolSummary (chat-tool-cards.js).

// Does this block start a new segment? The same test renderTimelineBlocks uses
// to decide a block is drawn at all.
function isSegmentBreak(b) {
  return !!b && ((b.type === 'text' && !!(b.text || '').trim()) || b.type === 'inject');
}

// The segment of every tool-start event, from the row's block timeline.
// Returns { count, of(startEvent) }: count is the last segment's index.
function toolSegmentsOf(blocks) {
  const segOfBlock = new Map();
  let seg = 0;
  for (const b of blocks || []) {
    if (!b) continue;
    if (isSegmentBreak(b)) seg++;
    if (b.id != null) segOfBlock.set(b.id, seg);
  }
  const last = seg;
  return {
    count: last,
    of(te) {
      if (!te || te.afterBlock === undefined) return last;
      if (te.afterBlock === null) return 0;
      return segOfBlock.has(te.afterBlock) ? segOfBlock.get(te.afterBlock) : last;
    },
  };
}

// "42s", "6m 12s", "1h 5m".
function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// The call in flight: the newest start with no end. Paired by call id, else
// by how many of that tool's calls have ended.
function _runningCall(toolEvents) {
  const starts = toolEvents.filter(t => t.type === 'start');
  const ends = toolEvents.filter(t => t.type === 'end');
  for (let i = starts.length - 1; i >= 0; i--) {
    const s = starts[i];
    const ended = s.toolCallId
      ? ends.some(e => e.toolCallId === s.toolCallId)
      : ends.filter(e => e.name === s.name).length > starts.slice(0, i).filter(x => x.name === s.name).length;
    if (!ended) return s;
  }
  return null;
}

// What kind of work each tool is, for the group's one-line summary. A tool not
// listed is named as itself ("used holdout_judge").
const _ACTIVITY_KINDS = [
  { test: /^(read|document_read|pdf_read|spreadsheet_read|app_read|view_image|read_my_logs|ocr)$/, say: (n) => n === 1 ? 'read 1 file' : `read ${n} files` },
  { test: /^(grep|glob|structural_search)$/, say: (n) => n === 1 ? 'searched once' : `searched ${n} times` },
  { test: /^(bash|process_start|process_restart)$/, say: (n) => n === 1 ? 'ran 1 command' : `ran ${n} commands` },
  { test: /^(edit|multi_edit|edit_lines|write|bulk_replace|delete_file|self_edit)$/, say: (n) => n === 1 ? 'edited 1 file' : `edited ${n} files` },
  { test: /^(web_search|image_search)$/, say: (n) => n === 1 ? 'searched the web' : `searched the web ${n} times` },
  { test: /^(web_fetch|http_request|browser|compare_pages)$/, say: (n) => n === 1 ? 'opened 1 web page' : `opened ${n} web pages` },
  { test: /^(recall|memory_search|memory_save)$/, say: (n) => n === 1 ? 'checked memory' : `checked memory ${n} times` },
];
const _MAX_NAMED_OTHERS = 2;

// "Read 2 files, searched 3 times, ran 1 command": one entry per call, named
// in the order each kind first ran.
function activitySummaryOf(names) {
  const parts = new Map(); // kind or tool name → { say, n }
  for (const name of names || []) {
    const kind = _ACTIVITY_KINDS.find((k) => k.test.test(name));
    const key = kind || 'tool:' + name;
    if (!parts.has(key)) parts.set(key, { say: kind ? kind.say : (n) => n === 1 ? `used ${name}` : `used ${name} ${n} times`, n: 0, other: !kind });
    parts.get(key).n++;
  }
  const phrases = [];
  let othersNamed = 0;
  let othersLeft = 0;
  for (const p of parts.values()) {
    if (p.other && othersNamed >= _MAX_NAMED_OTHERS) { othersLeft += p.n; continue; }
    if (p.other) othersNamed++;
    phrases.push(p.say(p.n));
  }
  if (othersLeft > 0) phrases.push(othersLeft === 1 ? '1 other action' : `${othersLeft} other actions`);
  const line = phrases.join(', ');
  return line ? line[0].toUpperCase() + line.slice(1) : '';
}

// What the turn has written so far, in tokens, from what streamed in: the
// text, the thinking and every call's arguments, at about four characters a
// token. An estimate (shown with "~"); a model that thinks without streaming
// it adds nothing until it does.
function turnTokenEstimate(store) {
  if (!store) return 0;
  let chars = (store.content || '').length + (store.reasoning || '').length;
  for (const t of store.toolEvents || []) {
    if (t.type !== 'start' || t.args == null) continue;
    chars += (typeof t.args === 'string' ? t.args : JSON.stringify(t.args)).length;
  }
  return Math.round(chars / 4);
}

function _formatTokens(n) {
  return n < 1000 ? String(n) : (n / 1000).toFixed(1) + 'k';
}

// The call's own clock shows once it has run this long.
const _CALL_CLOCK_AFTER_MS = 5000;

// The last line of a running reply, the one place the action in flight is
// named: "Running: npm run build… (15s of 2m 11s · ↓ ~1.5k tokens)", or
// "Thinking… (46s · ↓ ~15 tokens)" between calls. `turn` (the live bubble
// passes it): { live, startedMs, tokens, writing }. Without it (a caller with
// only the events), it shows only while a call runs, timed from the call.
// While a call runs, clicking the line opens the group it belongs to. The
// clocks tick without a rebuild (_tickTurnNow below).
function renderTurnNow(toolEvents, turn) {
  const t = turn || {};
  const call = _runningCall(toolEvents || []);
  if (!call && !t.live) return null;
  const el = document.createElement('div');
  el.className = 'turn-now';
  if (call) {
    el.classList.add('opens-group');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = 'Show the calls';
    el.addEventListener('click', () => openRunningGroup(el));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openRunningGroup(el); }
    });
  }
  const what = document.createElement('span');
  what.className = 'turn-now-what';
  if (call) {
    // toolSummary's own phrase where it has one ("Running: npm test", "Reading
    // a.ts"); for the rest it prints the raw arguments, so name the tool alone.
    const summary = toolSummary(call.name, call.args || '');
    what.textContent = summary.startsWith(call.name + ' ') ? 'Running ' + call.name : summary;
  } else {
    what.textContent = t.writing ? 'Writing' : 'Thinking';
  }
  const meta = document.createElement('span');
  meta.className = 'turn-now-meta';
  const callSince = call && typeof call.startedMs === 'number' ? call.startedMs : Date.now();
  const turnSince = typeof t.startedMs === 'number' && t.startedMs > 0 ? t.startedMs : null;
  if (call && turnSince !== null) {
    const callTime = document.createElement('span');
    callTime.className = 'turn-now-call';
    el.dataset.callSince = String(callSince);
    _setCallClock(callTime, Date.now() - callSince);
    meta.appendChild(callTime);
  }
  const since = turnSince !== null ? turnSince : callSince;
  el.dataset.since = String(since);
  const time = document.createElement('span');
  time.className = 'turn-now-elapsed';
  time.textContent = formatElapsed(Date.now() - since);
  meta.appendChild(time);
  if (t.tokens > 0) {
    const tokens = document.createElement('span');
    tokens.className = 'turn-now-tokens';
    tokens.textContent = '↓ ~' + _formatTokens(t.tokens) + ' tokens';
    meta.appendChild(tokens);
  }
  el.append(what, meta);
  return el;
}

function _setCallClock(span, ms) {
  span.textContent = ms >= _CALL_CLOCK_AFTER_MS ? formatElapsed(ms) + ' of' : '';
}

// The live line was clicked: open the group the running call is in (the
// newest running one in this reply) and bring it into view. The bubble is
// rebuilt on every event; its open state carries over (chat-render-open-state.js).
function openRunningGroup(line) {
  const body = line && line.closest('.msg-body');
  if (!body) return;
  const running = body.querySelectorAll('.activity-group.running');
  const all = body.querySelectorAll('.activity-group');
  const group = running[running.length - 1] || all[all.length - 1];
  if (!group) return;
  const header = group.querySelector('.activity-group-header');
  if (!group.classList.contains('open') && header && typeof toggleActivityGroup === 'function') toggleActivityGroup(header);
  if (typeof group.scrollIntoView === 'function') group.scrollIntoView({ block: 'nearest' });
}
if (typeof window !== 'undefined') window.openRunningGroup = openRunningGroup;

// Once a second, every visible running line's clocks. Text only: the bubble
// itself is rebuilt by its own events, never by this.
function _tickTurnNow() {
  const now = Date.now();
  document.querySelectorAll('.turn-now[data-since]').forEach((el) => {
    const t = el.querySelector('.turn-now-elapsed');
    if (t) t.textContent = formatElapsed(now - Number(el.dataset.since));
    const c = el.querySelector('.turn-now-call');
    if (c && el.dataset.callSince) _setCallClock(c, now - Number(el.dataset.callSince));
  });
}
if (typeof window !== 'undefined' && !window._turnNowTicker) window._turnNowTicker = setInterval(_tickTurnNow, 1000);
