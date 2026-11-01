// ── Chat: Rendering — the command on a shell approval card ──
//
// A shell ask carries its whole command and the folder it runs in as a typed
// preview ({ kind: 'shell', cmd, cwd, explanation }, src/types/server-events.ts,
// built by src/tool-execution/approval-card-text.ts). The card's line used to
// be the command cut at 150 characters: on a long command the `rm -rf` the
// card warned about sat past the cut, and the user was asked to approve text
// they could not read (2026-10-31). This block shows the command in full, no
// scroll box and no cut, under the card's line (which says why it is asking).
//
// The command was written by the model, so it is set with textContent, never
// parsed as HTML. The explanation is already the card's line; it is not
// repeated here.
//
// External deps: none. Called by renderApproval (chat-render-approvals.js).

function makeShellPreviewBlock(preview) {
  const box = document.createElement('div');
  box.className = 'shell-preview';
  const cmd = document.createElement('pre');
  cmd.className = 'shell-preview-command';
  cmd.textContent = String(preview.cmd || '');
  box.appendChild(cmd);
  if (preview.cwd) {
    const cwd = document.createElement('div');
    cwd.className = 'shell-preview-cwd';
    cwd.textContent = 'Runs in ' + String(preview.cwd);
    box.appendChild(cwd);
  }
  return box;
}

// Put the command under the card's line, above the buttons.
function applyShellPreview(card, preview) {
  if (!card || !preview || preview.kind !== 'shell') return;
  const block = makeShellPreviewBlock(preview);
  const line = card.querySelector('.approval-context');
  if (line && line.parentNode) line.parentNode.insertBefore(block, line.nextSibling);
  else card.insertBefore(block, card.querySelector('.approval-actions'));
}
