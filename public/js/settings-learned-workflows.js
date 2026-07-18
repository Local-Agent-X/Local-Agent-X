(function () {
  let mode = 'assisted';
  let items = [];
  let selectedId = null;

  function setStatus(text) {
    const status = document.getElementById('learned-workflows-status');
    if (status) status.textContent = text;
  }

  function render() {
    const list = document.getElementById('learned-workflows-list');
    if (!list) return;
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'learned-workflows-empty';
      empty.textContent = 'No learned workflows yet. They will appear after successful patterns repeat.';
      list.append(empty);
      return;
    }
    for (const item of items) list.append(renderRow(item));
  }

  function renderRow(item) {
    const row = document.createElement('div');
    row.className = 'learned-workflow-row';
    row.dataset.learningId = item.id;
    row.tabIndex = 0;
    row.onclick = () => openDetail(item.id);
    row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') openDetail(item.id); };

    const main = document.createElement('div');
    main.className = 'learned-workflow-main';
    const name = document.createElement('div');
    name.className = 'learned-workflow-name';
    name.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'learned-workflow-meta';
    meta.textContent = summary(item);
    main.append(name, meta);
    const state = document.createElement('div');
    state.className = 'learned-workflow-state';
    state.textContent = item.state;
    row.append(main, state);

    const actions = rowActions(item);
    if (actions.length) {
      const controls = document.createElement('div');
      controls.className = 'learned-workflow-actions';
      for (const action of actions) controls.append(actionButton(item, action));
      row.append(controls);
    }
    return row;
  }

  function rowActions(item) {
    if (mode === 'assisted' && item.state === 'candidate') return ['activate', 'reject'];
    if (item.state === 'archived') return ['restore'];
    if (item.state === 'active' || item.state === 'versioned') return ['archive'];
    return [];
  }

  function actionButton(item, action) {
    const button = document.createElement('button');
    button.textContent = action[0].toUpperCase() + action.slice(1);
    if (action === 'reject') button.className = 'reject';
    button.onclick = (event) => {
      event.stopPropagation();
      runAction(item.id, action);
    };
    return button;
  }

  function summary(item) {
    const confidence = Number.isFinite(item.confidence) ? Math.round(item.confidence * 100) + '% confidence' : '';
    const versions = item.versionCount > 1 ? item.versionCount + ' versions' : '';
    const updated = typeof item.updatedAt === 'string' ? 'updated ' + item.updatedAt.slice(0, 10) : '';
    const quiet = mode === 'autonomous' && item.state === 'candidate' ? 'qualifying quietly' : '';
    return [confidence, versions, updated, quiet].filter(Boolean).join(' · ');
  }

  async function refresh() {
    setStatus('Refreshing…');
    try {
      const data = await window.apiJson('/api/memory/learning');
      if (!Array.isArray(data.items)) throw new Error('Invalid learning response');
      mode = data.mode === 'autonomous' ? 'autonomous' : 'assisted';
      items = Array.isArray(data.items) ? data.items : [];
      setStatus(mode === 'autonomous' ? 'Learning automatically' : 'Review before activation');
      render();
      if (selectedId && items.some((item) => item.id === selectedId)) openDetail(selectedId);
    } catch {
      setStatus('Could not load');
      const list = document.getElementById('learned-workflows-list');
      if (list) list.innerHTML = '<div class="learned-workflows-empty">Learned workflows are temporarily unavailable.</div>';
    }
  }

  async function openDetail(id) {
    selectedId = id;
    try {
      const data = await window.apiJson('/api/memory/learning/' + encodeURIComponent(id));
      if (!data.item) throw new Error('Workflow not found');
      window.MemoryBrain?.openLearningInspector(data.item, (action, versionId) => runAction(id, action, versionId));
    } catch {
      setStatus('Could not load details');
    }
  }

  async function runAction(id, action, versionId) {
    const previous = items.map((item) => ({ ...item }));
    const current = items.find((item) => item.id === id);
    if (!current) return;
    const expectedActiveVersionId = current.activeVersionId;
    applyOptimistic(current, action, versionId);
    render();
    setStatus('Saving…');
    try {
      const data = await window.apiJson('/api/memory/learning/' + encodeURIComponent(id) + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, versionId, expectedActiveVersionId }),
      });
      if (!data.item) throw new Error(data.error || 'Action failed');
      items = items.map((item) => item.id === id ? { ...item, ...data.item } : item);
      setStatus(mode === 'autonomous' ? 'Learning automatically' : 'Saved');
      render();
      openDetail(id);
    } catch {
      items = previous;
      setStatus('Change failed — restored previous state');
      render();
    }
  }

  function applyOptimistic(item, action, versionId) {
    if (action === 'activate' || action === 'restore' || action === 'rollback') item.state = 'active';
    if (action === 'reject') item.state = 'rejected';
    if (action === 'archive') item.state = 'archived';
    if (action === 'rollback' && versionId) item.activeVersionId = versionId;
  }

  window.refreshLearnedWorkflows = refresh;
  document.addEventListener('DOMContentLoaded', refresh);
}());
