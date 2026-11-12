// Settings → Memory → "Recurring problems": tool calls that failed the same
// way in several chats, the lessons written for them (Keep puts a lesson on
// the result of that failure the next time it happens), and things the agent
// could not do with its own tools (server: src/routes/memory-problems.ts over
// src/cognition/cross-session-learning/).
(function () {
  let problems = [];
  let lessons = [];
  let gaps = [];

  const STATUS_LABEL = { error: 'Failed', blocked: 'Refused', timeout: 'Timed out' };
  const LESSON_LABEL = { proposed: 'Waiting for you', kept: 'In use', discarded: 'Discarded', retired: 'Stopped helping' };
  const VERDICT_NOTE = { noise: 'reviewed: nothing to learn', app_gap: 'reviewed: needs a fix in the app', lesson: 'reviewed: has a lesson' };

  function setStatus(text) {
    const status = document.getElementById('recurring-problems-status');
    if (status) status.textContent = text;
  }

  function day(at) {
    return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function toolName(item) {
    return item.action ? item.tool + ' (' + item.action + ')' : item.tool;
  }

  function row(text, metaParts, stateText) {
    const el = document.createElement('div');
    el.className = 'learned-workflow-row memory-change-row';
    const main = document.createElement('div');
    main.className = 'learned-workflow-main';
    const title = document.createElement('div');
    title.className = 'memory-change-text';
    title.textContent = text;
    const meta = document.createElement('div');
    meta.className = 'learned-workflow-meta';
    meta.textContent = metaParts.filter(Boolean).join(' · ');
    main.append(title, meta);
    const state = document.createElement('div');
    state.className = 'learned-workflow-state';
    state.textContent = stateText;
    el.append(main, state);
    return el;
  }

  function lessonRow(l) {
    const el = row(l.lesson, [
      'for ' + toolName(l) + ': ' + (l.reason || 'no message'),
      'failed in ' + plural(l.sessions, 'chat'),
      l.shown ? 'shown ' + plural(l.shown, 'time') + ', the retry worked ' + l.recovered : '',
    ], LESSON_LABEL[l.state] || l.state);
    const controls = document.createElement('div');
    controls.className = 'learned-workflow-actions';
    if (l.state !== 'kept') controls.append(actionButton(l, 'keep', 'Keep'));
    if (l.state === 'proposed' || l.state === 'kept') controls.append(actionButton(l, 'discard', 'Discard'));
    el.append(controls);
    return el;
  }

  function actionButton(lesson, action, label) {
    const button = document.createElement('button');
    button.textContent = label;
    if (action === 'discard') button.className = 'reject';
    button.onclick = () => decide(lesson, action, button);
    return button;
  }

  function problemRow(p) {
    return row(toolName(p) + ': ' + (p.reason || 'no message'), [
      plural(p.count, 'time') + ' in ' + plural(p.sessions, 'chat') + ' over ' + plural(p.days, 'day'),
      'last ' + day(p.lastSeen),
      p.layer ? 'refused by ' + p.layer : '',
      p.review ? (VERDICT_NOTE[p.review.verdict] || '') + (p.review.verdict !== 'lesson' && p.review.why ? ' (' + p.review.why + ')' : '') : '',
    ], STATUS_LABEL[p.status] || p.status);
  }

  function gapRow(g) {
    return row(g.summary, [
      day(g.at),
      g.toolsTried && g.toolsTried.length ? 'tried ' + g.toolsTried.join(', ') : '',
      g.workaround ? 'worked around: ' + g.workaround : '',
    ], 'Gap');
  }

  function render() {
    const list = document.getElementById('recurring-problems-list');
    if (!list) return;
    list.replaceChildren();
    if (!problems.length && !lessons.length && !gaps.length) {
      const empty = document.createElement('div');
      empty.className = 'learned-workflows-empty';
      empty.textContent = 'Nothing keeps going wrong. A failure appears here once it has happened in three chats on two different days.';
      list.append(empty);
      return;
    }
    for (const l of lessons) list.append(lessonRow(l));
    for (const p of problems) list.append(problemRow(p));
    for (const g of gaps) list.append(gapRow(g));
  }

  function summary() {
    const waiting = lessons.filter((l) => l.state === 'proposed').length;
    if (waiting) return plural(waiting, 'lesson') + ' waiting for you';
    return problems.length ? plural(problems.length, 'recurring failure') : '';
  }

  async function refresh() {
    try {
      const data = await window.apiJson('/api/memory/problems');
      if (!Array.isArray(data.problems) || !Array.isArray(data.gaps)) throw new Error('Invalid response');
      problems = data.problems;
      lessons = Array.isArray(data.lessons) ? data.lessons : [];
      gaps = data.gaps;
      setStatus(summary());
      render();
    } catch {
      setStatus('Could not load');
    }
  }

  async function decide(lesson, action, button) {
    button.disabled = true;
    setStatus('Saving…');
    try {
      const data = await window.apiJson('/api/memory/problems/' + encodeURIComponent(lesson.signature) + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!data.lesson) throw new Error(data.error || 'Change failed');
      await refresh();
    } catch (e) {
      button.disabled = false;
      setStatus((e && e.message) || 'Change failed');
    }
  }

  window.refreshRecurringProblems = refresh;
  document.addEventListener('DOMContentLoaded', refresh);
}());
