// ── Chat tool cards ──
//
// Tool-card UI: per-tool summary lines, the activity-group collapsible
// wrapper that groups consecutive tool calls, the approval card that asks
// the user to allow a high-risk call, and the structured chip that surfaces
// out-of-band metadata (e.g. blocked-by-op with a kill button) WITHOUT
// putting machine identifiers in the model's text channel — see
// test/op-submit-async-self-block.test.ts for why that matters.
//
// Extracted from chat.js as part of the 400-LOC god-file split. Functions
// stay window-scoped (classic script tag) so existing chat.js call sites
// keep working without a module rewrite.
//
// External deps from chat.js:
//   - window.esc                    (defined in shared.js)
//   - window.sendApprovalResponse   (helper exposed by chat.js — wraps the
//                                    chat WS send so this module never
//                                    touches chat WS state directly)

function toolSummary(name, args) {
  switch (name) {
    case 'browser': {
      const a = args.action || '';
      if (a === 'navigate') return `Opening ${args.url || 'page'}...`;
      if (a === 'snapshot') return 'Scanning page elements...';
      if (a === 'click') return args.ref ? `Clicking [${args.ref}]...` : `Clicking ${args.selector || 'element'}...`;
      if (a === 'click_text') return `Clicking "${args.text || ''}"...`;
      if (a === 'fill') return args.ref ? `Typing into [${args.ref}]...` : `Typing into ${args.selector || 'field'}...`;
      if (a === 'screenshot') return 'Taking screenshot...';
      if (a === 'extract') return 'Reading page content...';
      return `Browser: ${a}`;
    }
    case 'read': return `Reading ${(args.path || '').split(/[/\\]/).pop() || 'file'}`;
    case 'write': return `Writing ${(args.path || '').split(/[/\\]/).pop() || 'file'}`;
    case 'edit': return `Editing ${(args.path || '').split(/[/\\]/).pop() || 'file'}`;
    case 'bash': return `Running: ${(args.command || '').slice(0, 50)}`;
    case 'http_request': return `${args.method || 'GET'} ${(args.url || '').slice(0, 50)}`;
    case 'memory_search': return `Searching memory: "${(args.query || '').slice(0, 40)}"`;
    case 'memory_save': return `Saving to ${args.target || 'daily'} memory`;
    case 'generate_image': return `Generating: ${(args.prompt || '').slice(0, 40)}...`;
    case 'self_edit': return `Modifying LAX source: ${args.task || '(no task)'}`;
    default: return `${name} ${JSON.stringify(args).slice(0, 60)}`;
  }
}

function makeApprovalCard(approvalId, toolName, context, argsPreview) {
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.setAttribute('data-id', approvalId);
  card.innerHTML =
    '<div class="approval-header"><span class="approval-icon">&#9888;</span>'
    + '<div class="approval-title">Approval needed: <b>' + esc(toolName) + '</b></div></div>'
    + '<div class="approval-context">' + esc(context || '') + '</div>'
    + (argsPreview ? '<details class="approval-args"><summary>args</summary><pre>' + esc(argsPreview) + '</pre></details>' : '')
    + '<div class="approval-actions">'
    +   '<button class="btn-approve">Approve</button>'
    +   '<button class="btn-deny">Deny</button>'
    +   '<label class="approval-always"><input type="checkbox" class="always-cb"> Always for this session</label>'
    + '</div>'
    + '<div class="approval-status"></div>';

  const send = (approved) => {
    const always = card.querySelector('.always-cb').checked;
    try {
      if (typeof window.sendApprovalResponse === 'function') {
        window.sendApprovalResponse(approvalId, approved, approved && always);
      }
    } catch {}
    card.querySelector('.approval-status').textContent = approved ? (always ? 'Approved (remembered for session)' : 'Approved') : 'Denied';
    card.classList.add(approved ? 'approved' : 'denied');
    card.querySelectorAll('button').forEach(b => b.disabled = true);
  };
  card.querySelector('.btn-approve').addEventListener('click', () => send(true));
  card.querySelector('.btn-deny').addEventListener('click', () => send(false));
  return card;
}

function makeToolCard(name, args, riskLevel, context) {
  const card = document.createElement('div'); card.className = 'tool-card'; card.setAttribute('data-tool-name', name);
  card.setAttribute('data-call-count', '1');
  card.innerHTML = `<div class="tool-header" onclick="this.parentElement.classList.toggle('open')"><span class="indicator"></span><span class="tool-name">${esc(name)}</span><span class="tool-count" style="font-size:.7rem;margin-right:.3rem"></span><span class="tool-summary" style="color:var(--muted);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(toolSummary(name, args))}</span><span class="chevron">&#9654;</span></div>`
    + `<div class="tool-detail">executing...</div>`;
  return card;
}

/**
 * Render a structured chip on the most recent tool-card in `bodyEl`.
 * Tools (e.g. op_submit_async, self_edit) emit `tool_chip` events out-of-band
 * to surface op ids + kill buttons WITHOUT putting machine identifiers in
 * the model's text channel. Without out-of-band rendering the model parrots
 * its own host op id back as a fake delegation message — see
 * test/op-submit-async-self-block.test.ts.
 */
function appendToolChip(bodyEl, chip) {
  const cards = bodyEl.querySelectorAll('.tool-card');
  const last = cards[cards.length - 1];
  if (!last) return;
  const el = document.createElement('div');
  el.className = 'tool-chip';
  el.setAttribute('data-chip-kind', chip.kind || '');
  if (chip.opId) el.setAttribute('data-op-id', chip.opId);
  el.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin-top:.4rem;padding:.3rem .55rem;border:1px solid var(--border,#3a3a3a);border-radius:.4rem;background:rgba(255,255,255,.02);font-size:.72rem;color:var(--muted,#888)';
  const labelHtml = `<span class="chip-label" style="font-weight:600;color:var(--text,#ddd)">${esc(chip.label || 'Blocked')}</span>`;
  const detailHtml = chip.detail
    ? `<span class="chip-detail" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(chip.detail)}</span>`
    : '<span style="flex:1"></span>';
  el.innerHTML = labelHtml + detailHtml;
  if (Array.isArray(chip.actions)) {
    for (const a of chip.actions) {
      const btn = document.createElement('button');
      btn.className = 'chip-action';
      btn.textContent = a.label || a.tool || 'Run';
      btn.style.cssText = 'padding:.15rem .5rem;border:1px solid var(--border,#3a3a3a);border-radius:.3rem;background:transparent;color:inherit;font:inherit;cursor:pointer';
      btn.addEventListener('click', () => {
        btn.disabled = true; btn.textContent = '…';
        fetch('/api/op/kill', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op_id: a?.args?.op_id || chip.opId }),
        }).then(r => r.json()).then(j => {
          btn.textContent = j?.ok ? 'killed' : 'failed';
        }).catch(() => { btn.textContent = 'error'; btn.disabled = false; });
      });
      el.appendChild(btn);
    }
  }
  last.appendChild(el);
}

/**
 * Find or create the last activity-group inside this container. Activity
 * groups consolidate ALL consecutive tool calls within one assistant
 * response into a single collapsible block — instead of 15 stacked tool
 * cards flooding the chat, you see "⚙ Agent activity (15)" with a
 * click-to-expand header.
 */
function ensureActivityGroup(container) {
  const last = container.lastElementChild;
  if (last && last.classList && last.classList.contains('activity-group')) {
    return last;
  }
  const group = document.createElement('div');
  group.className = 'activity-group';
  group.style.cssText = 'border:1px solid var(--border,#333);border-radius:6px;margin:.4rem 0;overflow:hidden;background:var(--surface-2,rgba(0,0,0,0.15))';
  group.innerHTML =
    `<div class="activity-group-header" style="cursor:pointer;padding:.4rem .6rem;display:flex;align-items:center;gap:.5rem;font-size:.75rem;color:var(--muted);user-select:none" onclick="this.parentElement.classList.toggle('open');this.querySelector('.activity-chevron').textContent=this.parentElement.classList.contains('open')?'\\u25BC':'\\u25B6'">` +
      `<span style="opacity:.8">⚙</span>` +
      `<span class="activity-label" style="flex:1">Agent activity</span>` +
      `<span class="activity-count" style="font-variant-numeric:tabular-nums">0</span>` +
      `<span class="activity-chevron">▶</span>` +
    `</div>` +
    `<div class="activity-group-body" style="max-height:320px;overflow-y:auto;padding:0 .4rem .4rem"></div>`;
  const styleId = '_activityGroupCSS';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = '.activity-group:not(.open) .activity-group-body{display:none}';
    document.head.appendChild(s);
  }
  container.appendChild(group);
  return group;
}

function appendToolCardGrouped(container, name, args, riskLevel, context) {
  const group = ensureActivityGroup(container);
  const body = group.querySelector('.activity-group-body');
  const cards = body.querySelectorAll('.tool-card');
  const last = cards[cards.length - 1];

  // Same-name dedup INSIDE the group (preserves the legacy "bash x6" UX).
  if (last && last.getAttribute('data-tool-name') === name) {
    const count = parseInt(last.getAttribute('data-call-count') || '1', 10) + 1;
    last.setAttribute('data-call-count', String(count));
    const countEl = last.querySelector('.tool-count');
    if (countEl) countEl.textContent = '×' + count;
    const summary = last.querySelector('.tool-summary');
    if (summary) summary.textContent = toolSummary(name, args);
    const detail = last.querySelector('.tool-detail');
    if (detail) {
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:.72rem;color:var(--muted);padding:.2rem 0;border-top:1px solid var(--border,#333);margin-top:.2rem';
      sub.textContent = '#' + count + ' ' + toolSummary(name, args);
      detail.appendChild(sub);
    }
    bumpActivityCount(group);
    return last;
  }
  const card = makeToolCard(name, args, riskLevel, context);
  body.appendChild(card);
  bumpActivityCount(group);
  return card;
}

function bumpActivityCount(group) {
  const countEl = group.querySelector('.activity-count');
  if (!countEl) return;
  const cur = parseInt(countEl.getAttribute('data-total') || '0', 10) + 1;
  countEl.setAttribute('data-total', String(cur));
  countEl.textContent = String(cur);
  const label = group.querySelector('.activity-label');
  if (label) label.textContent = cur >= 5 ? `Agent activity — ${cur} actions` : 'Agent activity';
}

function updateToolProgress(container, toolName, message) {
  // Find the last tool card matching this tool name
  const cards = container.querySelectorAll('.tool-card[data-tool-name="' + toolName + '"]');
  let card = cards.length > 0 ? cards[cards.length - 1] : null;
  if (!card) { const all = container.querySelectorAll('.tool-card'); card = all.length > 0 ? all[all.length - 1] : null; }
  if (!card) return;

  const detailEl = card.querySelector('.tool-detail');
  if (!detailEl) return;
  const summary = card.querySelector('.tool-summary');

  // Two message shapes:
  //   structured: "45%|237/1102 conversations, 500 chunks|conversations-003.json"
  //               → fills the existing progress bar
  //   free-form:  "Calling Write…" / a sentence from a CLI subprocess
  //               → wraps multi-line in a scrollable text panel (build_app's
  //                 codex/claude streams emit free-form, sometimes long)
  const parts = message.split('|');
  const pctMaybe = parts.length >= 2 ? parseInt(parts[0], 10) : NaN;
  const isStructured = !isNaN(pctMaybe) && pctMaybe >= 0 && pctMaybe <= 100;

  if (isStructured) {
    const detail = parts[1] || '';
    const file = parts[2] || '';
    if (summary) summary.textContent = detail;
    const oldText = detailEl.querySelector('.tool-progress-text');
    if (oldText) oldText.remove();
    let bar = detailEl.querySelector('.tool-progress-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'tool-progress-bar';
      bar.innerHTML = '<div class="tool-progress-fill"></div><span class="tool-progress-label"></span>';
      detailEl.textContent = '';
      detailEl.appendChild(bar);
      card.classList.add('open');
    }
    const fill = bar.querySelector('.tool-progress-fill');
    const label = bar.querySelector('.tool-progress-label');
    if (fill) fill.style.width = pctMaybe + '%';
    if (label) label.textContent = pctMaybe + '% — ' + detail + (file ? ' (' + file + ')' : '');
  } else {
    if (summary) summary.textContent = message;
    const oldBar = detailEl.querySelector('.tool-progress-bar');
    if (oldBar) oldBar.remove();
    let textEl = detailEl.querySelector('.tool-progress-text');
    if (!textEl) {
      textEl = document.createElement('div');
      textEl.className = 'tool-progress-text';
      detailEl.textContent = '';
      detailEl.appendChild(textEl);
      card.classList.add('open');
    }
    textEl.textContent = message;
  }
}

// Inline media preview for generate_image / generate_video tool results.
// Scans the result text for /images/<filename> or /videos/<filename> URLs
// and injects an <img> / <video> directly into the assistant's message
// body — NOT inside the collapsed Agent activity dropdown. The dropdown
// keeps the tool metadata; the image is the artifact and belongs in the
// chat at full size.
//
// Static routes /images/ and /videos/ require ?token= for auth (request-
// handler.ts gates them). AUTH_TOKEN comes from shared.js.
function attachMediaPreview(card, toolName, result) {
  if (!card || !result) return;
  if (toolName !== 'generate_image' && toolName !== 'generate_video') return;

  // Find the assistant message body to host the preview. Fall back to the
  // card itself if we can't locate one (shouldn't happen in practice).
  const host = card.closest('.msg-body') || card.closest('.msg.assistant') || card.parentElement;
  if (!host) return;

  // Two shapes carry the artifact location:
  //  • live tool_end text has a ready URL:  /images/X.png  or  /videos/X.mp4
  //  • reloaded sessions carry the model-facing form the UI projection
  //    persisted instead of the original result — "Image loaded:
  //    workspace\images\X.png" — a bare backslash path with no URL. Without
  //    matching that, generated images vanish on every chat reload.
  // Normalize both to the auth-gated /images|/videos/<file> static route.
  const found = [];
  const urlRe = /\/(?:images|videos)\/[A-Za-z0-9._-]+/g;
  for (const m of result.matchAll(urlRe)) found.push(m[0]);
  const pathRe = /workspace[\\/](images|videos)[\\/]([A-Za-z0-9._-]+)/g;
  for (const m of result.matchAll(pathRe)) found.push('/' + m[1] + '/' + m[2]);
  // Dedupe — tool results commonly emit the same artifact twice (e.g. "Saved
  // at workspace\images\X.png ... URL: /images/X.png") which would otherwise
  // produce two side-by-side previews of the same image.
  let matches = [...new Set(found)];
  if (matches.length === 0) return;

  // Skip artifacts already previewed in this message body. The same image can
  // reach attachMediaPreview through more than one render pass for one turn
  // (the live swap paints it, then finalize rebuilds; a re-emitted tool event
  // can also repeat it). attachMediaPreview has no other cross-call dedupe, so
  // without this the same generated image stacks twice in the bubble.
  const already = new Set(
    [...host.querySelectorAll('.tool-media-preview img, .tool-media-preview video')]
      .map(el => (el.getAttribute('src') || '').split('?')[0])
  );
  matches = matches.filter(p => !already.has(p));
  if (matches.length === 0) return;

  const tok = (typeof AUTH_TOKEN === 'string' && AUTH_TOKEN) ? '?token=' + encodeURIComponent(AUTH_TOKEN) : '';
  const wrap = document.createElement('div');
  wrap.className = 'tool-media-preview';
  wrap.style.cssText = 'margin:.6rem 0;display:flex;flex-wrap:wrap;gap:.5rem';

  for (const path of matches) {
    const url = path + tok;
    if (path.startsWith('/videos/')) {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.preload = 'metadata';
      v.style.cssText = 'max-width:100%;max-height:520px;border-radius:8px;background:#000';
      wrap.appendChild(v);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'generated image';
      img.loading = 'lazy';
      img.style.cssText = 'max-width:100%;max-height:640px;border-radius:8px;display:block';
      a.appendChild(img);
      wrap.appendChild(a);
    }
  }
  // Insert above the activity-group so the image is the first thing the
  // user sees, with the tool-call metadata tucked below it.
  const group = host.querySelector(':scope > .activity-group');
  if (group) host.insertBefore(wrap, group);
  else host.appendChild(wrap);
}
