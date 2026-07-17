// ── ChatStreamStore: approval + sidebar methods ──
//
// Attached onto window.ChatStreamStore after the core loads (app.html
// order); split out of chat-stream-store.js for the 400-LOC gate. Uses the
// _ChatStreamState handle (entries/ensure/notify) the core exposes — no
// state of its own.

(function() {
  const S = window._ChatStreamState;
  const entries = S.entries;
  const ensure = S.ensure;
  const notify = S.notify;

  function setSidebarActive(sessionId, active) {
    if (!sessionId) return;
    const e = ensure(sessionId);
    if (e.sidebarActive === !!active) return;
    e.sidebarActive = !!active;
    notify(sessionId, null);
  }

  // Sync to the server's `active_chats` snapshot — sessions not in the list
  // lose their sidebar marker (but keep their streaming state if any).
  function setActiveSidebarSet(sessionIds) {
    const set = new Set(sessionIds || []);
    for (const [sid, e] of entries) {
      const next = set.has(sid);
      if (e.sidebarActive !== next) { e.sidebarActive = next; notify(sid, null); }
    }
    for (const sid of set) {
      const e = ensure(sid);
      if (!e.sidebarActive) { e.sidebarActive = true; notify(sid, null); }
    }
  }

  // Locate an approval card across all entries by its id — card click
  // handlers and the durable-resolve reply only know the approvalId.
  function findApproval(approvalId) {
    if (!approvalId) return null;
    for (const [sessionId, e] of entries) {
      const ap = e.approvals.find(a => a.id === approvalId);
      if (ap) return { sessionId, approval: ap };
    }
    return null;
  }

  // Optimistic local flip when the user clicks Approve/Deny — the server's
  // approval_resolved event confirms it, but a re-render in the gap between
  // click and server echo must not resurrect an actionable card. Scans all
  // entries because the card click only knows the approvalId.
  function resolveApprovalLocal(approvalId, approved) {
    const found = findApproval(approvalId);
    if (!found) return;
    found.approval.status = approved ? 'approved' : 'denied';
    found.approval.resolvedAt = Date.now();
    notify(found.sessionId, null);
  }

  // Server confirmed the decision was durably RECORDED (approval_resolved
  // reply carrying delivery:"recorded") — the approval wasn't live
  // in-process (server restarted since the ask); it applies when the agent
  // resumes. Distinct from resolveApprovalLocal so renders can show the
  // "Recorded" state instead of a normal live settle.
  function resolveApprovalRecorded(approvalId, approved) {
    const found = findApproval(approvalId);
    if (!found) return;
    found.approval.status = approved ? 'approved' : 'denied';
    found.approval.delivery = 'recorded';
    found.approval.resolvedAt = Date.now();
    notify(found.sessionId, null);
  }

  Object.assign(window.ChatStreamStore, {
    setSidebarActive, setActiveSidebarSet,
    findApproval, resolveApprovalLocal, resolveApprovalRecorded,
  });
})();
