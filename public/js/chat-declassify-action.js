// ── Chat: the security-block notice, and its "Declassify & retry" button ──
//
// A blocked tool result whose block is the security kernel's or the session
// taint's gets a NOTICE on the assistant row itself — outside the collapsible
// "Agent activity" group, beside the approvals — because a control inside a
// collapsed group is a control nobody sees (2026-09-27: the model told the
// user to click a card that was folded away, then lost on reload). The notice
// says which rule fired and what ends the block; the button appears only when
// the block is a session taint the user can clear (metadata.clearable). The
// CLICK is the deliberate, attributed authorization: the server writes the
// tamper-evident declassify audit event (routes/security.ts), and on success a
// retry message is auto-sent so the agent resumes without the user
// hand-typing anything.
//
// External deps (runtime globals): esc (shared.js), apiPost (shared-api.js),
// window.sendMessage (chat-send.js).

/**
 * Is this blocked tool result one the USER can clear themselves?
 *
 * The policy layer decides and says so (`metadata.clearable`), set wherever a
 * blocker's recovery text names this button — see EgressBlocker.clearable.
 * The layer-name list is a legacy fallback for cards rebuilt from stored events
 * that predate the flag, and must never be the primary test: a kernel taint
 * quarantine reports layer "arikernel" nested inside "egress-aggregate", which
 * matched nothing, so the card silently never rendered for the block class that
 * most needed it (2026-09-18).
 */
const LEGACY_TAINT_LAYERS = ['data-lineage', 'tainted-shell'];

/**
 * Is this block a strict web-access refusal the USER can lift by allowing the
 * site? The policy layer says so (`metadata.clearable === 'allow-host'`) and
 * names the host; the button below posts that host to the allowlist.
 */
function isAllowHostBlock(metadata) {
  const md = metadata || {};
  return md.clearable === 'allow-host' && typeof md.host === 'string' && md.host !== '';
}

function isDeclassifiable(metadata) {
  const md = metadata || {};
  if (md.clearable === 'declassify') return true;
  if (LEGACY_TAINT_LAYERS.includes(md.layer)) return true;
  return Array.isArray(md.layers) && md.layers.some(l => LEGACY_TAINT_LAYERS.includes(l));
}

/**
 * Does this tool result warrant the notice at all? Every kernel block does —
 * clearable or not — and so does the re-surfaced control show_unblock_control
 * emits (layer "quarantine-notice"). A host-allowlist or canary block is a
 * plain blocked card: the model's own recovery text covers it.
 */
function isKernelBlockNotice(metadata) {
  const md = metadata || {};
  if (isDeclassifiable(md) || isAllowHostBlock(md)) return true;
  if (md.layer === 'arikernel' || md.layer === 'quarantine-notice') return true;
  if (Array.isArray(md.layers) && md.layers.includes('arikernel')) return true;
  return !!md.quarantine;
}

/**
 * The notice element for one blocked (or re-surfaced) tool end event. Placed
 * by chat-render-artifacts.js on the assistant row, never inside the activity
 * group. The button is appended only for a clearable block; a run-rule
 * quarantine says so and that it ends with the turn.
 */
function renderKernelBlockNotice(endEvt, sessionId) {
  const md = (endEvt && endEvt.metadata) || {};
  const q = md.quarantine || null;
  const rule = md.rule || (q && q.rule) || '';
  const el = document.createElement('div');
  el.className = 'kernel-block-notice';
  if (rule) el.setAttribute('data-rule', String(rule));
  let text;
  if (isAllowHostBlock(md)) {
    text = 'Web access: ' + md.host + ' is not on your allowed sites, so the call was refused. '
      + 'Allowing it adds the site to Settings → Security → Web access and the agent retries.';
  } else if (isDeclassifiable(md)) {
    text = 'Security block: this session is quarantined by a sensitive read, so outbound calls that could carry that data are refused'
      + (rule ? ' (kernel rule ' + rule + ')' : '') + '. Clearing it is your call.';
  } else if (q && q.trigger === 'behavioral_rule') {
    // One call refused by a run rule; the turn goes on.
    const call = endEvt && endEvt.name && md.layer !== 'quarantine-notice' ? ' refused ' + endEvt.name : ' refused a call';
    const standing = typeof q.threshold === 'number'
      ? ' Refusal ' + q.deniedActions + ' of ' + q.threshold + ' before the kernel pauses the turn.' : '';
    text = 'Security block: kernel rule ' + rule + call + (q.reason ? ' (' + q.reason + ')' : '')
      + '. Only that call was refused; the turn continues.' + standing;
  } else {
    const why = rule ? ' — rule ' + rule + (q && q.reason ? ': ' + q.reason : '') : '';
    // A re-surfaced notice (show_unblock_control) describes the state; a
    // block names the call it refused.
    const refused = md.layer === 'quarantine-notice' || !(endEvt && endEvt.name)
      ? '' : ' It refused ' + endEvt.name + ';';
    text = 'Security block: the kernel paused this turn' + why + '.' + refused
      + ' there is nothing to click. The block ends with this turn — your next message starts clean.';
  }
  el.innerHTML = '<span class="kernel-block-text">' + esc(text) + '</span>';
  if (isAllowHostBlock(md)) appendAllowHostAction(el, md.host);
  else if (isDeclassifiable(md)) appendDeclassifyAction(el, sessionId);
  return el;
}

function appendDeclassifyAction(card, sessionId) {
  if (!card || !sessionId || card.querySelector('.declassify-action')) return;
  const el = document.createElement('div');
  el.className = 'tool-chip declassify-action';
  el.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin-top:.4rem;padding:.3rem .55rem;border:1px solid var(--border,#3a3a3a);border-radius:.4rem;background:rgba(255,255,255,.02);font-size:.72rem;color:var(--muted,#888)';
  el.innerHTML = '<span class="chip-label" style="font-weight:600;color:var(--text,#ddd)">Session quarantined by a sensitive read</span><span style="flex:1"></span>';
  const btn = document.createElement('button');
  btn.className = 'chip-action';
  btn.textContent = '🔓 Declassify & retry';
  btn.style.cssText = 'padding:.15rem .5rem;border:1px solid var(--border,#3a3a3a);border-radius:.3rem;background:transparent;color:inherit;font:inherit;cursor:pointer';
  btn.addEventListener('click', () => {
    btn.disabled = true; btn.textContent = '…';
    apiPost('/api/security/declassify', { sessionId, reason: 'User clicked Declassify & retry on a taint-blocked tool card' }).then(j => {
      if (!j || j.ok !== true) throw new Error(j && j.error ? j.error : 'declassify failed');
      // cleared === 0: the taint this card was drawn for is already gone (a
      // server restart drops it, or it was declassified once already). Say so
      // rather than claim a release that did not happen; the retry still goes.
      const stale = j.cleared === 0;
      btn.textContent = stale ? '✓ Already clear' : '✓ Declassified';
      const input = document.getElementById('msg-input');
      if (input && typeof window.sendMessage === 'function') {
        input.value = stale
          ? 'The session quarantine is already clear. Retry the step that was blocked.'
          : 'I cleared the session quarantine (declassified). Retry the step that was blocked.';
        window.sendMessage();
      }
    }).catch(() => { btn.textContent = '✗ Failed — restart the session'; btn.disabled = false; });
  });
  el.appendChild(btn);
  card.appendChild(el);
}

function appendAllowHostAction(card, host) {
  if (!card || !host || card.querySelector('.allow-host-action')) return;
  const el = document.createElement('div');
  el.className = 'tool-chip allow-host-action';
  el.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin-top:.4rem;padding:.3rem .55rem;border:1px solid var(--border,#3a3a3a);border-radius:.4rem;background:rgba(255,255,255,.02);font-size:.72rem;color:var(--muted,#888)';
  const label = document.createElement('span');
  label.className = 'chip-label';
  label.style.cssText = 'font-weight:600;color:var(--text,#ddd)';
  label.textContent = 'Site not allowed: ' + host;
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  const btn = document.createElement('button');
  btn.className = 'chip-action';
  btn.textContent = 'Allow ' + host + ' & retry';
  btn.style.cssText = 'padding:.15rem .5rem;border:1px solid var(--border,#3a3a3a);border-radius:.3rem;background:transparent;color:inherit;font:inherit;cursor:pointer';
  btn.addEventListener('click', () => {
    btn.disabled = true; btn.textContent = '…';
    apiPost('/api/security/egress', { allow: host }).then(j => {
      if (!j || j.ok !== true) throw new Error(j && j.error ? j.error : 'allow failed');
      btn.textContent = '✓ Allowed';
      const input = document.getElementById('msg-input');
      if (input && typeof window.sendMessage === 'function') {
        input.value = 'I allowed ' + host + ' for web access. Retry the step that was blocked.';
        window.sendMessage();
      }
    }).catch(() => { btn.textContent = '✗ Failed — allow it in Settings → Security → Web access'; btn.disabled = false; });
  });
  el.appendChild(label);
  el.appendChild(spacer);
  el.appendChild(btn);
  card.appendChild(el);
}
