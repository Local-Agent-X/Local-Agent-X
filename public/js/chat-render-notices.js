// Delete notices — files the agent deleted to the trash WITHOUT a card, because
// this request created them and the user did not name them
// (src/tool-execution/unnamed-delete-gate.ts): its own scratch. The trade for
// skipping the card is that what went is on record with an Undo — as a line
// inside the activity group (chat-render-artifacts.js), since cleaning up its
// own probe file is agent activity, not an alert. Saved on the row by
// chat-stream-finalize.js, so Undo survives a reload.
//
// Exposes (global): renderDeleteNotice(notice), renderLearningNotice(notice)

function _noticeBaseName(p) {
  const parts = String(p || '').split(/[\\/]/);
  return parts[parts.length - 1] || String(p || '');
}

function renderDeleteNotice(n) {
  const el = document.createElement('div');
  el.className = 'delete-notice';
  el.setAttribute('data-id', n.id || '');
  const files = Array.isArray(n.files) ? n.files : [];
  const count = files.length + ' file' + (files.length === 1 ? '' : 's');
  const names = files.map(f => '<span class="delete-notice-file" title="' + esc(f) + '">' + esc(_noticeBaseName(f)) + '</span>').join(', ');

  const paint = () => {
    if (n.restored) {
      el.classList.add('restored');
      el.innerHTML = '<span class="delete-notice-text">Restored ' + count + ': ' + names + '.</span>';
      return;
    }
    el.innerHTML =
      '<span class="delete-notice-text">Deleted ' + count + ' it created this turn: '
      + names + ' — in the trash.</span>'
      + '<button class="delete-notice-undo" type="button">Undo</button>'
      + (n.error ? '<div class="delete-notice-error">' + esc(n.error) + '</div>' : '');
    el.querySelector('.delete-notice-undo').addEventListener('click', undo);
  };

  const undo = async () => {
    const btn = el.querySelector('.delete-notice-undo');
    if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }
    try {
      const sessionId = (window.activeChat && window.activeChat.id) || undefined;
      const res = await apiFetch('/api/trash/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: files, sessionId }),
      });
      const data = await res.json();
      const failed = (data.results || []).filter(r => r.error);
      if (!res.ok || failed.length) {
        n.error = failed.length ? failed.map(r => r.error).join(' ') : (data.error || 'Restore failed.');
      } else {
        n.restored = true;
        delete n.error;
      }
    } catch (err) {
      n.error = 'Restore failed: ' + (err && err.message ? err.message : String(err));
    }
    try { if (typeof saveChats === 'function') saveChats(); } catch { /* the notice still shows the outcome */ }
    paint();
  };

  paint();
  return el;
}

// Learning notices — the post-turn review proposed a learned workflow from this
// chat (src/protocols/learned-review-drafting.ts). It is a draft until the user
// keeps it: Keep activates the proposed version, Discard rejects the proposal —
// or, for a new version of a workflow already in use, just dismisses it and the
// current version stays. Both go through POST /api/memory/learning/:id/action,
// the same route the Settings → Learned workflows panel uses.
//
// Exposes (global): renderLearningNotice(notice)

function renderLearningNotice(n) {
  const el = document.createElement('div');
  el.className = 'learning-notice';
  el.setAttribute('data-id', n.id || '');
  const name = '<span class="learning-notice-name">' + esc(n.name || '') + '</span>';
  const settled = {
    kept: 'Kept ' + name + '. The agent will use it from now on.',
    discarded: 'Discarded ' + name + '.',
    dismissed: 'Dismissed the new version of ' + name + '. The current one stays in use.',
  };

  const paint = () => {
    if (settled[n.status]) {
      el.classList.add('settled');
      el.innerHTML = '<span class="learning-notice-text">' + settled[n.status] + '</span>';
      return;
    }
    el.innerHTML =
      '<span class="learning-notice-text">' + (n.refinement ? 'Refined a learned workflow: ' : 'Learned a workflow: ')
      + name + (n.description ? ' — ' + esc(n.description) : '') + '</span>'
      + '<button class="learning-notice-keep" type="button">Keep</button>'
      + '<button class="learning-notice-discard" type="button">Discard</button>'
      + (n.error ? '<div class="learning-notice-error">' + esc(n.error) + '</div>' : '');
    el.querySelector('.learning-notice-keep').addEventListener('click', () => act('activate'));
    el.querySelector('.learning-notice-discard').addEventListener('click', () => act(n.canReject ? 'reject' : 'dismiss'));
  };

  const save = () => {
    try { if (typeof saveChats === 'function') saveChats(); } catch { /* the notice still shows the outcome */ }
  };

  const act = async (action) => {
    if (action === 'dismiss') {
      n.status = 'dismissed';
      delete n.error;
      save();
      paint();
      return;
    }
    el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const body = action === 'activate'
        ? { action, versionId: n.versionId, expectedActiveVersionId: n.expectedActiveVersionId || null }
        : { action };
      const res = await apiFetch('/api/memory/learning/' + encodeURIComponent(n.candidateId) + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        n.status = action === 'activate' ? 'kept' : 'discarded';
        delete n.error;
      } else {
        n.error = (res.status === 409 ? 'This workflow changed since.' : 'That did not work.')
          + ' Review it in Settings → Learned workflows.';
      }
    } catch (err) {
      n.error = 'Request failed: ' + (err && err.message ? err.message : String(err));
    }
    save();
    paint();
  };

  paint();
  return el;
}

// Review notices — a publish ran and its pre-publish review found something
// (src/tool-execution/publish-review-gate.ts announcePublishReview). Shown here
// so the findings reach the user whether or not the agent repeats them.
//
// Exposes (global): renderReviewNotice(notice)

function renderReviewNotice(n) {
  const el = document.createElement('div');
  const status = String(n.status || '').toLowerCase();
  el.className = 'review-notice review-notice-' + status;
  el.setAttribute('data-id', n.id || '');
  const findings = Array.isArray(n.findings) ? n.findings : [];
  const head = 'Pre-publish review: ' + esc(n.status || '') + ' — ' + findings.length + ' finding'
    + (findings.length === 1 ? '' : 's') + (n.summary ? ' in ' + esc(n.summary) : '') + '. It shipped; worth a look:';
  const items = findings.map(f =>
    '<li class="review-notice-finding review-notice-' + esc(f.severity || '') + '">'
    + '<span class="review-notice-severity">' + esc(f.severity || '') + '</span> '
    + '<span class="review-notice-location">' + esc(f.location || '') + '</span> '
    + esc(f.problem || '')
    + (f.fix ? '<div class="review-notice-fix">Fix: ' + esc(f.fix) + '</div>' : '')
    + '</li>').join('');
  el.innerHTML = '<div class="review-notice-text">' + head + '</div><ul class="review-notice-list">' + items + '</ul>';
  return el;
}

// Handoff notices — the agent offers to continue this chat's coding work in
// Code mode (src/tools/code-handoff-tool.ts): a session on the repo, starting
// from the brief it wrote. The button runs the same move the sidebar's
// "Continue in a code session" does (chat.js continueInCodeSession), with the
// repo and the brief. Once opened, the notice says so instead of offering again.
//
// Exposes (global): renderHandoffNotice(notice)

function renderHandoffNotice(n) {
  const el = document.createElement('div');
  el.className = 'handoff-notice';
  el.setAttribute('data-id', n.id || '');
  const where = '<code>' + esc(n.folder || '') + '</code>';
  const paint = () => {
    if (n.status === 'opened') {
      el.classList.add('settled');
      el.innerHTML = '<span class="handoff-notice-text">Moved to Code mode: a session on ' + where + ', starting from ' + esc(n.brief || '') + '.</span>';
      return;
    }
    el.innerHTML =
      '<span class="handoff-notice-text">This work fits Code mode better: a session on ' + where
      + ' that starts from the handoff ' + esc(n.brief || '') + '.</span>'
      + '<button class="handoff-notice-open" type="button">Continue in Code mode</button>'
      + (n.error ? '<div class="learning-notice-error">' + esc(n.error) + '</div>' : '');
    el.querySelector('.handoff-notice-open').addEventListener('click', open);
  };
  const open = async () => {
    el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const chatId = (typeof activeChat !== 'undefined' && activeChat) ? activeChat.id : null;
    const opened = chatId && typeof continueInCodeSession === 'function'
      ? await continueInCodeSession(chatId, null, { folder: n.folder, brief: n.brief })
      : false;
    if (opened) { n.status = 'opened'; delete n.error; } else { n.error = 'Could not open the code session. Try the sidebar\u2019s Code tab.'; }
    try { if (typeof saveChats === 'function') saveChats(); } catch { /* the notice still shows the outcome */ }
    paint();
  };
  paint();
  return el;
}
