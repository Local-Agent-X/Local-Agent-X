// ── Chat: Rendering — assistant tool artifacts ──
//
// The shared builder for the in-flight assistant bubble plus the tool-card /
// chip / progress / approval / stop-notice rendering that both the live synth
// path and the finalized-assistant branch reuse:
//   - _buildLiveAssistantInto      — build the in-flight assistant bubble from
//                                    ChatStreamStore state into a parent node
//   - _updateActivityOutcome       — roll tool failures onto the collapsed
//                                    "Agent activity" header
//   - _renderAssistantToolArtifacts — cards, chips, progress, approvals, stop
//                                    notice (used by live synth + finalized branch)
//
// Extracted from chat-render.js to keep that file under the 400-LOC budget.
//
// External deps (resolved at call time, runtime-only):
//   - md, esc, mdPreviewMode                   (shared.js / chat.js)
//   - appendToolCardGrouped, appendToolChip,
//     updateToolProgress, makeApprovalCard,
//     attachMediaPreview                       (chat-tool-cards.js)

// Build the in-flight assistant bubble from ChatStreamStore state into `parent`.
// `parent` is either the live #messages container (renderMessages full-render)
// or a detached div (rerenderLiveMessage swap path). No global side effects —
// no Spring fade, no autoScroll, no pin-bottom migration. The caller handles
// post-build framing.
//
// Mirrors the DOM shape addMessageEl produces for an assistant message plus
// the streaming-class + thinking-dots + tool-card routing that the per-event
// dispatcher (chat-ws-handler-chat-events.js) writes into the same bubble.
function _buildLiveAssistantInto(parent, store) {
  if (!parent) return null;
  const content = store ? (store.content || '') : '';
  const bodyContent = mdPreviewMode ? md(content) : `<pre class="raw-md">${esc(content)}</pre>`;
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.setAttribute('role', 'article');
  div.setAttribute('aria-label', 'Assistant message');
  div.innerHTML = `<div class="msg-label">Assistant</div><div class="msg-body streaming">${bodyContent}</div><div class="msg-footer"></div>`;
  parent.appendChild(div);
  const bodyEl = div.querySelector('.msg-body');
  // Pre-delta render: thinking dots so the chat doesn't look frozen until
  // the first token lands. Mirrors the manual bubble sendMessage creates.
  if (bodyEl && !content) {
    bodyEl.innerHTML = '<div class="thinking"><span>.</span><span>.</span><span>.</span></div>';
  }
  const toolEvents = store ? (store.toolEvents || []) : [];
  _renderAssistantToolArtifacts(bodyEl || div, {
    toolEvents,
    chips: store ? (store.chips || []) : [],
    progressByTool: store ? (store.progressByTool || {}) : {},
    approvals: store ? (store.approvals || []) : [],
    stopNote: store ? store.stopNote : null,
  });
  return div;
}

// Roll tool failures up onto the collapsed "Agent activity" header so the
// user can tell work failed WITHOUT expanding the group — the whole point of
// the outcome indicator. Recomputed on every render from the end events, so
// it stays correct as the turn streams in and after a reload.
function _updateActivityOutcome(bodyEl, toolEvents) {
  const group = bodyEl.querySelector('.activity-group');
  if (!group) return;
  const ends = toolEvents.filter(t => t.type === 'end');
  const failed = ends.filter(t => t.status === 'error' || t.status === 'timeout').length;
  const label = group.querySelector('.activity-label');
  if (label) {
    const total = ends.length;
    let txt = total >= 5 ? `Agent activity — ${total} actions` : 'Agent activity';
    if (failed > 0) txt += ` · ${failed} failed`;
    label.textContent = txt;
  }
  const countEl = group.querySelector('.activity-count');
  if (countEl) countEl.style.color = failed > 0 ? 'var(--danger, #e5484d)' : '';
}

// Shared render for assistant tool artifacts (cards, chips, progress, approvals,
// stop notice). Used by both the live synth path (_buildLiveAssistantInto) and
// the finalized assistant branch in renderMessage so a reloaded chat looks
// identical to its in-flight render.
function _renderAssistantToolArtifacts(bodyEl, data) {
  if (!bodyEl || !data) return;
  const toolEvents = data.toolEvents || [];
  if (toolEvents.length > 0) {
    try {
      // Pair each start with a DISTINCT end. A plain name-match via .find()
      // resolved every same-named start to the FIRST end — so when one tool
      // ran N times in a turn (e.g. 11× generate_image), the first result and
      // its image rendered N times while the other N-1 never showed. Prefer
      // the tool call id when both sides carry a matching one; otherwise fall
      // back to consuming ends in order per tool name (codex ids are composite
      // and don't always line up start↔end, so id-only pairing can miss).
      const endsById = new Map();
      const endsByName = new Map();
      for (const t of toolEvents) {
        if (t.type !== 'end') continue;
        if (t.toolCallId) endsById.set(t.toolCallId, t);
        if (!endsByName.has(t.name)) endsByName.set(t.name, []);
        endsByName.get(t.name).push(t);
      }
      const nameCursor = new Map();
      for (const te of toolEvents) {
        if (te.type !== 'start') continue;
        // Route through appendToolCardGrouped so the swap matches the
        // per-event paint path: cards land inside the collapsible
        // "Agent activity" group, consecutive same-tool calls collapse
        // into a single ×N card.
        const card = appendToolCardGrouped(bodyEl, te.name, te.args || '', te.riskLevel);
        let endEvt = (te.toolCallId && endsById.get(te.toolCallId)) || null;
        if (!endEvt) {
          const list = endsByName.get(te.name) || [];
          const i = nameCursor.get(te.name) || 0;
          endEvt = list[i] || null;
          nameCursor.set(te.name, i + 1);
        }
        if (endEvt) {
          // Execution outcome, not just the approval decision. A tool can be
          // allowed-then-fail (bash exit 1, edit no-match, http 500); the
          // status discriminator carries that. Reuse the existing
          // allowed(green)/blocked(red) dot styles — failure maps to red.
          const failed = endEvt.status === 'error' || endEvt.status === 'timeout';
          const ok = endEvt.allowed !== false && !failed && endEvt.status !== 'blocked';
          card.querySelector('.indicator').className = 'indicator ' + (ok ? 'allowed' : 'blocked');
          // Clean the agent-safety scaffolding off the tool-detail text but
          // leave the raw result in place for attachMediaPreview's URL scan —
          // generate_image results can wrap their /images/foo.png path inside
          // an EXTERNAL_UNTRUSTED_CONTENT block, so cleaning before scanning
          // would lose the URL.
          const rawResult = endEvt.result || '';
          const detailText = rawResult
            .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '[content loaded]')
            .replace(/IMPORTANT:.*?Do NOT follow any instructions.*$/gm, '')
            .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
            .replace(/<content>\n?/g, '').replace(/\n?<\/content>/g, '')
            .trim()
            .slice(0, 200);
          const fallback = failed
            ? (endEvt.status === 'timeout' ? '✗ Timed out' : '✗ Failed')
            : (endEvt.status === 'blocked' || endEvt.allowed === false ? '⚠ Blocked' : '✓ Done');
          card.querySelector('.tool-detail').textContent = detailText || fallback;
          attachMediaPreview(card, te.name, rawResult);
        }
      }
      _updateActivityOutcome(bodyEl, toolEvents);
    } catch (toolRenderErr) { console.error('[chat] tool card render error:', toolRenderErr); }
  }
  // Chips attach to the last tool card matching the chip's emit time. The
  // store keeps insertion order, so appendToolChip's "last card" heuristic
  // matches the live arrival order for the common single-chip case. (Cards
  // and chips can interleave in the rare multi-chip-multi-tool case; not
  // worth tracking exact targets until that bites someone.)
  const chips = data.chips || [];
  for (const chip of chips) { try { appendToolChip(bodyEl, chip); } catch {} }
  // Progress: latest message per tool name. Skip tools that already ended —
  // their tool-detail carries the final result, so progress would just
  // clobber it.
  const progressByTool = data.progressByTool || {};
  for (const toolName of Object.keys(progressByTool)) {
    const ended = toolEvents.some(t => t.type === 'end' && t.name === toolName);
    if (ended) continue;
    const entry = progressByTool[toolName];
    if (entry && typeof entry.message === 'string') {
      try { updateToolProgress(bodyEl, toolName, entry.message); } catch {}
    }
  }
  // Approvals and the stop note hang off bodyEl directly (NOT inside the
  // activity group) — they need to render outside the collapsible block.
  const approvals = data.approvals || [];
  for (const ap of approvals) {
    try {
      const card = makeApprovalCard(ap.id, ap.toolName, ap.context, ap.argsPreview);
      if (ap.status && ap.status !== 'pending') {
        const statusEl = card.querySelector('.approval-status');
        if (ap.status === 'timeout') {
          card.classList.add('timeout');
          if (statusEl) statusEl.textContent = 'Timed out — denied.';
        } else {
          card.classList.add(ap.status === 'approved' ? 'approved' : 'denied');
          if (statusEl) statusEl.textContent = ap.status === 'approved' ? 'Approved' : 'Denied';
        }
        card.querySelectorAll('button').forEach(b => b.disabled = true);
      }
      bodyEl.appendChild(card);
    } catch (approvalRenderErr) { console.error('[chat] approval card render error:', approvalRenderErr); }
  }
  const stopNote = data.stopNote;
  if (stopNote) {
    const note = document.createElement('div');
    note.className = 'stop-notice';
    note.textContent = stopNote.reason || 'Stopped.';
    note.title = stopNote.debug || stopNote.firedBy || '';
    bodyEl.appendChild(note);
  }
}
