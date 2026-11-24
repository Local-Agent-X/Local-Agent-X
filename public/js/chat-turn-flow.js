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
// Exposes (global): isSegmentBreak, toolSegmentsOf, renderTurnNow, formatElapsed
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

// The last line of a running reply: what it is running and for how long. Null
// when no call is in flight (text is streaming, or the turn-start dots show).
// The elapsed time ticks without a rebuild (_tickTurnNow below).
function renderTurnNow(toolEvents) {
  const call = _runningCall(toolEvents || []);
  if (!call) return null;
  const el = document.createElement('div');
  el.className = 'turn-now';
  const since = typeof call.startedMs === 'number' ? call.startedMs : Date.now();
  el.dataset.since = String(since);
  const what = document.createElement('span');
  what.className = 'turn-now-what';
  // toolSummary's own phrase where it has one ("Running: npm test", "Reading
  // a.ts"); for the rest it prints the raw arguments, so name the tool alone.
  const summary = toolSummary(call.name, call.args || '');
  what.textContent = summary.startsWith(call.name + ' ') ? 'Running ' + call.name : summary;
  const time = document.createElement('span');
  time.className = 'turn-now-elapsed';
  time.textContent = formatElapsed(Date.now() - since);
  el.append(what, time);
  return el;
}

// Once a second, every visible running line's clock. Text only: the bubble
// itself is rebuilt by its own events, never by this.
function _tickTurnNow() {
  const now = Date.now();
  document.querySelectorAll('.turn-now[data-since]').forEach((el) => {
    const t = el.querySelector('.turn-now-elapsed');
    if (t) t.textContent = formatElapsed(now - Number(el.dataset.since));
  });
}
if (typeof window !== 'undefined' && !window._turnNowTicker) window._turnNowTicker = setInterval(_tickTurnNow, 1000);
