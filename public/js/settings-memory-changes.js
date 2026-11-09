// Settings → Memory → "Memory changes": every memory the agent or a
// background job changed, retired or removed, who did it and why, with Undo
// (server: src/routes/memory-changes.ts over src/memory/fact-events.ts).
(function () {
  let items = [];
  let query = '';

  const OP_LABEL = { end: 'Retired', reopen: 'Brought back', change: 'Changed', delete: 'Removed', create: 'Saved' };
  const ACTOR_LABEL = {
    agent: 'the agent, in a chat',
    resolver: 'background extraction',
    sweep: 'background cleanup',
    background: 'a background job',
    sync: 'sync from another computer',
    'user:undo': 'you (undo)',
    'user:erase': 'you (erase)',
    'agent:undo': 'the agent (undo, at your word)',
    earlier: 'unrecorded (before the change log)',
    unknown: 'unrecorded',
  };

  function setStatus(text) {
    const status = document.getElementById('memory-changes-status');
    if (status) status.textContent = text;
  }

  function when(at) {
    const d = new Date(at);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function renderRow(item) {
    const row = document.createElement('div');
    row.className = 'learned-workflow-row memory-change-row' + (item.undone ? ' memory-change-undone' : '');
    const main = document.createElement('div');
    main.className = 'learned-workflow-main';
    const text = document.createElement('div');
    text.className = 'memory-change-text';
    text.textContent = item.text || '(erased at your request)';
    const meta = document.createElement('div');
    meta.className = 'learned-workflow-meta';
    const parts = [OP_LABEL[item.op] || item.op, 'by ' + (ACTOR_LABEL[item.actor] || item.actor), when(item.at)];
    if (item.was) parts.push('was: ' + item.was);
    if (item.reason) parts.push(item.reason);
    if (item.undone) parts.push('undone');
    meta.textContent = parts.join(' · ');
    main.append(text, meta);
    row.append(main);
    if (item.undoable) {
      const controls = document.createElement('div');
      controls.className = 'learned-workflow-actions';
      const button = document.createElement('button');
      button.textContent = 'Undo';
      button.onclick = () => undo(item, button);
      controls.append(button);
      row.append(controls);
    }
    return row;
  }

  function render() {
    const list = document.getElementById('memory-changes-list');
    if (!list) return;
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'learned-workflows-empty';
      empty.textContent = query ? 'No changes match.' : 'No memory has been changed yet.';
      list.append(empty);
      return;
    }
    for (const item of items) list.append(renderRow(item));
  }

  async function refresh() {
    try {
      const data = await window.apiJson('/api/memory/changes?limit=60' + (query ? '&q=' + encodeURIComponent(query) : ''));
      if (!Array.isArray(data.items)) throw new Error('Invalid response');
      items = data.items;
      setStatus('');
      render();
    } catch {
      setStatus('Could not load');
    }
  }

  async function undo(item, button) {
    button.disabled = true;
    setStatus('Undoing…');
    try {
      const data = await window.apiJson('/api/memory/changes/' + item.id + '/undo', { method: 'POST' });
      if (!data.ok) throw new Error(data.error || 'Undo failed');
      setStatus(data.message);
      await refresh();
      setStatus(data.message);
    } catch (e) {
      button.disabled = false;
      setStatus((e && e.message) || 'Undo failed');
    }
  }

  function wire() {
    const search = document.getElementById('memory-changes-search');
    if (search) {
      let timer = null;
      search.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { query = search.value.trim(); refresh(); }, 250);
      };
    }
    refresh();
  }

  window.refreshMemoryChanges = refresh;
  document.addEventListener('DOMContentLoaded', wire);
}());
