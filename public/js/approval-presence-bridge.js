// ── Approval cards → the desktop app ──
//
// Reports every chat approval card to the desktop app as it appears and as it
// settles, so the app can reach the user wherever they are
// (desktop/src/approval-presence.ts): nothing extra while LAX is in front, a
// toast when LAX is behind another window, the phone when nobody is at the
// computer. When the user clicks that toast the app brings LAX forward and
// this opens the card's chat and scrolls the card into view.
//
// Called by chat-ws-handler-chat-events.js for each live approval_* event.
// Outside the desktop app (a browser tab) it does nothing.

(function () {
  var desktop = window.desktop;
  if (!desktop || typeof desktop.approvalPending !== 'function') {
    window.reportApprovalEvent = function () {};
    return;
  }

  window.reportApprovalEvent = function (sessionId, event) {
    if (!event || !event.approvalId) return;
    if (event.type === 'approval_requested') {
      desktop.approvalPending({
        approvalId: String(event.approvalId),
        sessionId: String(sessionId || ''),
        context: String(event.context || ''),
        toolName: String(event.toolName || ''),
        expiresAt: typeof event.expiresAt === 'number' ? event.expiresAt : undefined,
      });
    } else if (event.type === 'approval_resolved' || event.type === 'approval_timeout') {
      desktop.approvalSettled(String(event.approvalId));
    }
  };

  if (typeof desktop.onFocusApproval === 'function') {
    desktop.onFocusApproval(function (target) {
      if (!target) return;
      var viewing = typeof activeChat !== 'undefined' && activeChat && activeChat.id === target.sessionId;
      if (target.sessionId && !viewing && typeof selectChat === 'function') selectChat(target.sessionId);
      // After the chat has painted: the card is looked up in the live document.
      if (typeof announceApproval === 'function') setTimeout(function () { announceApproval(target.approvalId); }, 150);
    });
  }
})();
