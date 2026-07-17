// ── Chat: one-click "Declassify & retry" on a taint-blocked tool card ──
//
// Rendered by chat-render-artifacts.js only when a blocked tool result's
// authoritative layer is session taint (data-lineage / tainted-shell) — the
// one user-clearable block class; egress-allowlist and canary blocks are not.
// The CLICK is the deliberate, attributed authorization: the server writes the
// tamper-evident declassify audit event (routes/security.ts), and on success a
// retry message is auto-sent so the agent resumes without the user
// hand-typing anything.
//
// External deps (runtime globals): apiPost (shared-api.js),
// window.sendMessage (chat-send.js).

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
      btn.textContent = '✓ Declassified';
      const input = document.getElementById('msg-input');
      if (input && typeof window.sendMessage === 'function') {
        input.value = 'I cleared the session quarantine (declassified). Retry the step that was blocked.';
        window.sendMessage();
      }
    }).catch(() => { btn.textContent = '✗ Failed — use Settings → Security'; btn.disabled = false; });
  });
  el.appendChild(btn);
  card.appendChild(el);
}
