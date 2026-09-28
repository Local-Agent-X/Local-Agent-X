// ── Chat: Rendering — pre-publish review on an approval card ──
//
// A git push / deploy / package publish / release is reviewed by a fresh model
// before it is approved (src/tool-execution/publish-review-gate.ts). The ask
// carries that review as a typed preview ({ kind: 'publish-review', ... },
// src/types/server-events.ts); this module turns it into a read-only block on
// the card: a verdict chip, what was reviewed, and the findings (severity,
// path:line, problem, why, fix). The only controls stay the card's own
// approve/deny — on a RED card the approve button is relabeled with the
// override wording the server sends ("Push anyway"), because that is what
// clicking it does.
//
// Everything in a finding was written by a model reading the diff, so it is
// set with textContent, never parsed as HTML.
//
// External deps: none. Called by renderApproval (chat-render-approvals.js).

const _PUBLISH_STATUS_TEXT = {
  RED: 'RED — do not ship',
  AMBER: 'AMBER — fix soon',
  GREEN: 'GREEN — no blocking issues',
  FAILED: 'FAILED — not reviewed',
  UNKNOWN: 'UNKNOWN — not reviewed',
  EMPTY: 'Nothing new ships',
};

function _pr_el(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

function makePublishReviewBlock(preview) {
  const status = String(preview.status || 'FAILED');
  const box = _pr_el('div', 'publish-review status-' + status.toLowerCase());
  const head = _pr_el('div', 'publish-review-head');
  head.appendChild(_pr_el('span', 'publish-review-chip', _PUBLISH_STATUS_TEXT[status] || status));
  head.appendChild(_pr_el('span', 'publish-review-label', 'Pre-publish review'));
  box.appendChild(head);
  if (preview.command) box.appendChild(_pr_el('div', 'publish-review-command', preview.command));
  if (preview.summary) box.appendChild(_pr_el('div', 'publish-review-summary', preview.summary));
  if (preview.reason) box.appendChild(_pr_el('div', 'publish-review-reason', preview.reason));
  const findings = Array.isArray(preview.findings) ? preview.findings : [];
  if (findings.length) {
    const list = _pr_el('ul', 'publish-review-findings');
    for (const f of findings) {
      const item = _pr_el('li', 'publish-review-finding sev-' + String(f.severity || 'yellow'));
      const top = _pr_el('div', 'publish-review-finding-top');
      top.appendChild(_pr_el('span', 'publish-review-sev', String(f.severity || '')));
      top.appendChild(_pr_el('span', 'publish-review-loc', String(f.location || '')));
      item.appendChild(top);
      item.appendChild(_pr_el('div', 'publish-review-problem', String(f.problem || '')));
      if (f.why) item.appendChild(_pr_el('div', 'publish-review-why', String(f.why)));
      if (f.fix) item.appendChild(_pr_el('div', 'publish-review-fix', 'Fix: ' + String(f.fix)));
      list.appendChild(item);
    }
    box.appendChild(list);
  } else if (status === 'GREEN') {
    box.appendChild(_pr_el('div', 'publish-review-summary', 'The reviewer found no issues.'));
  }
  const unknown = Array.isArray(preview.unknown) ? preview.unknown : [];
  for (const u of unknown) {
    box.appendChild(_pr_el('div', 'publish-review-reason', 'Not reviewed: ' + String(u.label || '') + ' — ' + String(u.reason || '')));
  }
  return box;
}

// Decorate a live approval card whose ask carries a publish review.
function applyPublishReview(card, preview) {
  if (!card || !preview || preview.kind !== 'publish-review') return;
  card.classList.add('publish-review-card');
  card.insertBefore(makePublishReviewBlock(preview), card.querySelector('.approval-actions'));
  if (preview.overrideLabel) {
    const approve = card.querySelector('.btn-approve');
    if (approve) {
      approve.textContent = preview.overrideLabel;
      approve.classList.add('override');
    }
  }
}
