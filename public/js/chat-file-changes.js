// ── Chat: the files a reply changed ──
//
// Under a reply that wrote or edited files: an "Edited N files" card, one row
// per file with the lines it added and removed. A row (or "See all") opens the
// right panel's CHANGES tab on the diff: removed lines red, added lines green,
// the unchanged stretches between hunks folded to a "N unmodified lines" row.
//
// Data: each write/edit tool_end's metadata.fileChange (src/tools/file-change.ts),
// which the live event and the reloaded row both carry, so the card is a pure
// function of the turn's tool events and repaints identically.
//
// External deps (resolved at call time): esc (shared.js),
// switchSidePanelTab (chat-artifacts.js), toggleAgentFeeds + agentFeedsOpen
// (chat-agent-feeds*.js).

// The files a turn changed, in the order first touched. A file edited several
// times keeps every edit; its counts are their sum.
function fileChangesOf(toolEvents) {
  const byPath = new Map();
  for (const t of toolEvents || []) {
    const fc = t && t.type === 'end' && t.metadata && t.metadata.fileChange;
    if (!fc || typeof fc.path !== 'string') continue;
    const file = byPath.get(fc.path);
    if (file) {
      file.added += fc.added || 0;
      file.removed += fc.removed || 0;
      file.edits.push(fc);
    } else {
      byPath.set(fc.path, { path: fc.path, created: !!fc.created, added: fc.added || 0, removed: fc.removed || 0, edits: [fc] });
    }
  }
  return [...byPath.values()];
}

function _splitPath(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { name: path.slice(i + 1), dir: i >= 0 ? path.slice(0, i) : '' };
}

function _countsHTML(file) {
  return `<span class="fc-add">+${file.added}</span> <span class="fc-del">-${file.removed}</span>`;
}

function renderFileChangesCard(files) {
  const card = document.createElement('div');
  card.className = 'file-changes';
  const verb = files.every(f => f.created) ? 'Created' : 'Edited';
  card.innerHTML = `<div class="file-changes-head"><span>${verb} ${files.length} file${files.length === 1 ? '' : 's'}</span>` +
    '<button type="button" class="file-changes-all">See all</button></div>';
  card.querySelector('.file-changes-all').addEventListener('click', () => openFileChanges(files, null));
  for (const file of files) {
    const { name, dir } = _splitPath(file.path);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'file-change-row';
    row.title = file.path;
    row.innerHTML = `<span class="fc-name">${esc(name)}</span><span class="fc-dir">${esc(dir)}</span><span class="fc-counts">${_countsHTML(file)}</span>`;
    row.addEventListener('click', () => openFileChanges(files, file.path));
    card.appendChild(row);
  }
  return card;
}

// The change set the CHANGES tab shows.
var fileChangesView = null;

function openFileChanges(files, focusPath) {
  fileChangesView = { files, focusPath };
  const tabBtn = document.getElementById('side-tab-changes');
  if (tabBtn) tabBtn.style.display = '';
  if (typeof agentFeedsOpen !== 'undefined' && !agentFeedsOpen && typeof toggleAgentFeeds === 'function') toggleAgentFeeds();
  switchSidePanelTab('changes');
}

function _gapRow(lines) {
  const row = document.createElement('div');
  row.className = 'diff-gap';
  row.textContent = `⋯ ${lines} unmodified line${lines === 1 ? '' : 's'}`;
  return row;
}

function _diffLine(kind, oldNo, newNo, text) {
  const row = document.createElement('div');
  row.className = 'diff-line ' + kind;
  row.innerHTML = '<span class="diff-ln"></span><span class="diff-ln"></span><span class="diff-sign"></span><span class="diff-code"></span>';
  const cells = row.children;
  cells[0].textContent = oldNo == null ? '' : String(oldNo);
  cells[1].textContent = newNo == null ? '' : String(newNo);
  cells[2].textContent = kind === 'add' ? '+' : kind === 'del' ? '-' : '';
  cells[3].textContent = text;
  return row;
}

// One write's hunks, with the unchanged stretch before each folded to a count.
function _renderEdit(container, fc) {
  if (!Array.isArray(fc.hunks)) {
    const note = document.createElement('div');
    note.className = 'diff-note';
    note.textContent = fc.created ? 'New file; its contents are not shown here.' : 'This change is not shown here (a credential file, or too large to compare).';
    container.appendChild(note);
    return;
  }
  let oldNext = 1;
  for (const h of fc.hunks) {
    const skipped = h.oldStart - oldNext;
    if (skipped > 0) container.appendChild(_gapRow(skipped));
    let o = h.oldStart;
    let n = h.newStart;
    for (const line of h.lines) {
      const sign = line[0];
      const text = line.slice(1);
      if (sign === '+') container.appendChild(_diffLine('add', null, n++, text));
      else if (sign === '-') container.appendChild(_diffLine('del', o++, null, text));
      else container.appendChild(_diffLine('ctx', o++, n++, text));
    }
    oldNext = o;
  }
  if (fc.truncated) {
    const note = document.createElement('div');
    note.className = 'diff-note';
    note.textContent = 'The rest of this diff is too long to show.';
    container.appendChild(note);
  }
}

function _unifiedText(file) {
  return file.edits.flatMap(fc => (fc.hunks || []).flatMap(h => h.lines)).join('\n');
}

function renderFileChangesTab() {
  const body = document.getElementById('changes-list');
  if (!body) return;
  body.innerHTML = '';
  if (!fileChangesView || fileChangesView.files.length === 0) {
    body.innerHTML = '<div class="artifacts-empty">Open a reply\'s changed files to see what changed.</div>';
    return;
  }
  let focusEl = null;
  for (const file of fileChangesView.files) {
    const section = document.createElement('section');
    section.className = 'diff-file';
    const head = document.createElement('div');
    head.className = 'diff-file-head';
    head.innerHTML = `<span class="diff-path"></span><span class="fc-counts">${_countsHTML(file)}</span>` +
      '<button type="button" class="diff-copy" title="Copy this diff">Copy</button>';
    head.querySelector('.diff-path').textContent = file.path;
    head.querySelector('.diff-copy').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      navigator.clipboard.writeText(_unifiedText(file)).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }, () => { btn.textContent = 'Copy failed'; });
    });
    section.appendChild(head);
    const lines = document.createElement('div');
    lines.className = 'diff-lines';
    file.edits.forEach((fc, i) => {
      if (file.edits.length > 1) {
        const sep = document.createElement('div');
        sep.className = 'diff-edit-sep';
        sep.textContent = `Edit ${i + 1} of ${file.edits.length}`;
        lines.appendChild(sep);
      }
      _renderEdit(lines, fc);
    });
    section.appendChild(lines);
    body.appendChild(section);
    if (file.path === fileChangesView.focusPath) focusEl = section;
  }
  if (focusEl) focusEl.scrollIntoView({ block: 'start' });
  else body.scrollTop = 0;
}
