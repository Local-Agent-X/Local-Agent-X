// Settings → Memory → "Recurring problems": tool calls that failed the same
// way in several chats, and things the agent could not do with its own tools
// (server: src/routes/memory-problems.ts over
// src/cognition/cross-session-learning/failure-patterns.ts and capability-gaps.ts).
(function () {
  let problems = [];
  let gaps = [];

  const STATUS_LABEL = { error: 'Failed', blocked: 'Refused', timeout: 'Timed out' };

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

  function problemRow(p) {
    const name = p.action ? p.tool + ' (' + p.action + ')' : p.tool;
    return row(name + ': ' + (p.reason || 'no message'), [
      plural(p.count, 'time') + ' in ' + plural(p.sessions, 'chat') + ' over ' + plural(p.days, 'day'),
      'last ' + day(p.lastSeen),
      p.layer ? 'refused by ' + p.layer : '',
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
    if (!problems.length && !gaps.length) {
      const empty = document.createElement('div');
      empty.className = 'learned-workflows-empty';
      empty.textContent = 'Nothing keeps going wrong. A failure appears here once it has happened in three chats on two different days.';
      list.append(empty);
      return;
    }
    for (const p of problems) list.append(problemRow(p));
    for (const g of gaps) list.append(gapRow(g));
  }

  async function refresh() {
    try {
      const data = await window.apiJson('/api/memory/problems');
      if (!Array.isArray(data.problems) || !Array.isArray(data.gaps)) throw new Error('Invalid response');
      problems = data.problems;
      gaps = data.gaps;
      setStatus(problems.length ? plural(problems.length, 'recurring failure') : '');
      render();
    } catch {
      setStatus('Could not load');
    }
  }

  window.refreshRecurringProblems = refresh;
  document.addEventListener('DOMContentLoaded', refresh);
}());
