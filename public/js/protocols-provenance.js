// ── Protocols: provenance rendering ──
// Who wrote a protocol, and who has changed it since. The agent both authors
// and patches protocols with no confirmation gate, so this is the only place a
// user can tell agent work from their own — archive is the undo, and this is
// how you know what needs undoing.
//
// Split out of protocols.js to stay under the 400-LOC source-hygiene gate, the
// same reason protocols-archive.js exists. Loads BEFORE protocols-archive.js
// and protocols.js; both call in at render time, never at load time.

// Self-contained ON PURPOSE, and used for text positions here as well as
// attributes. Three files declare a global esc() — shared-escape.js,
// protocols.js, apps.js — and classic-script function declarations overwrite
// the global binding, so the last <script> in app.html decides which one runs.
// An escaper used on agent-authored strings must not have its correctness
// picked by script order. This one does the whole job itself: textContent →
// innerHTML covers & < >, and both quote characters are added here rather than
// borrowed. It is a strict superset of every esc() in the repo, so it is also
// correct in a text position — quotes just render as themselves.
function escAttr(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Authorship is FOUR-state, and NEITHER field may be read as a boolean:
//   authoredBy 'agent'                       → the agent wrote it, unprompted
//   authoredBy 'user'                        → you wrote it
//   authoredBy 'user' + lastEditedBy 'agent' → you wrote it, agent changed it
//   absent                                   → unknown
// Both fields are absent on every protocol written before provenance existed,
// so absent means UNKNOWN / NEVER — never "user". Crediting the user with work
// the agent may have done is the single failure this badge exists to prevent.
// The fourth state is not cosmetic: the background review fork's preferred move
// is patching an existing protocol, and it deliberately does NOT rewrite
// authoredBy when that protocol is the user's (they really did author it), so
// lastEditedBy is the only trace that the body changed hands.
function protocolAuthorship(p) {
  const s = p?.source || {};
  const base = s.authoredBy === 'agent' ? { key: 'agent', label: 'the agent, unprompted' }
    : s.authoredBy === 'user' ? { key: 'user', label: 'you' }
      : { key: 'unknown', label: 'not recorded' };
  // An agent edit of the agent's OWN protocol adds no state — it is already
  // badged as agent work end to end. The case that must not stay silent is an
  // agent edit of a protocol the agent did not author.
  if (s.lastEditedBy !== 'agent' || base.key === 'agent') return base;
  return {
    key: `${base.key}-agent-edited`, label: base.label, agentEdited: true,
    editedOn: s.lastEditedAt ? new Date(s.lastEditedAt).toLocaleDateString() : '',
  };
}

// Tag precedence: agent involvement wins (authored, else edited), then
// imported/custom collapse to one "custom" tag (internal plumbing); app-shipped
// tiers get no tag. The edited case gets its own label rather than reusing
// "agent" — the list is where a user scans for what to review, and "the agent
// rewrote something you wrote" is a different fact from "the agent wrote this".
function protocolSourceTag(p) {
  const a = protocolAuthorship(p);
  if (a.key === 'agent' || a.agentEdited) {
    const label = a.agentEdited ? 'agent-edited' : 'agent';
    const title = a.agentEdited
      ? 'The agent has rewritten this protocol since it was authored. Open it to review or archive.'
      : 'Written by the agent on its own. Open it to review or archive.';
    return `<span class="proto-item-source" style="margin-left:auto;color:var(--accent);border:1px solid var(--accent);border-radius:4px;padding:0 5px" title="${escAttr(title)}">${escAttr(label)}</span>`;
  }
  return (p.source?.type === 'imported' || p.source?.type === 'custom') ? `<span class="proto-item-source" style="margin-left:auto">custom</span>` : '';
}

// Detail-pane provenance. Authored-when and edited-when are separate fields on
// purpose: two dates in one sentence read as one fact, and the whole point of
// the fourth state is that they are two different events.
function protocolProvenanceParts(p) {
  const a = protocolAuthorship(p);
  const at = p?.source?.authoredAt ? ` on ${new Date(p.source.authoredAt).toLocaleDateString()}` : '';
  const parts = [`written by: <strong>${escAttr(a.label)}</strong>${escAttr(at)}`];
  if (a.agentEdited) parts.push(`changed since by: <strong>the agent</strong>${escAttr(a.editedOn ? ` on ${a.editedOn}` : '')}`);
  return parts;
}

// No confirmation prompt precedes an agent write OR an agent patch, so the
// detail pane is the first place a user can review one — say it plainly, next
// to the recoverable exit. Deliberately makes no claim about who authored an
// edited protocol: the line above already says "you" or "not recorded".
function protocolAgentNotice(p) {
  const a = protocolAuthorship(p);
  const text = a.key === 'agent' ? "The agent wrote this itself after a task — you weren't asked."
    : a.agentEdited ? "The agent rewrote this protocol after a task — you weren't asked." : '';
  if (!text) return '';
  return `<div class="proto-meta" style="border-left:2px solid var(--accent);padding-left:10px;margin-top:10px">${escAttr(text)} <strong>Archive</strong> removes it and keeps it restorable.</div>`;
}
