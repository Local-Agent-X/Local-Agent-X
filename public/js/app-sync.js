// ── App Shell: Server ↔ client sync ──
// Pulls sessions/projects from the backend, reconciles with the localStorage
// snapshot in app-state.js, and lazy-hydrates full session bodies on demand.
// All reads/writes go through the shared script-scope `chats`/`projects`
// bindings declared in app-state.js.

// Fetch chats from server (source of truth), merge with cache.
// Sidebar render only needs {id, title, updatedAt, messageCount} — full
// message bodies are fetched lazily in selectChat() on click. Eagerly
// fetching every session here used to fan-out 50+ GETs on page load,
// draining the per-token rate-limit bucket and 429ing legitimate work
// (voice session polls, WS reconnects). Pay the per-session cost only
// when the user actually opens that chat.
async function syncChatsFromServer() {
  try {
    const res = await fetch(`${API}/api/sessions`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!res.ok) return;
    const serverList = await res.json(); // [{id, title, updatedAt, messageCount}]

    const localMap = new Map(chats.map(c => [c.id, c]));
    const merged = [];
    const seen = new Set();
    const deletedIds = getDeletedIds();

    for (const srv of serverList) {
      seen.add(srv.id);
      if (deletedIds[srv.id]) continue;
      const local = localMap.get(srv.id);
      // Mid-stream protection: NEVER replace the local chat object while a
      // stream is in flight for this session. Replacing it orphans the
      // streamChat closure reference in sendMessage.
      // Per-session via _liveStreams: the singular streamingSessionId races
      // whenever main chat + IDE app-builder stream concurrently. Sync must
      // not replace a local chat object that's mid-stream, regardless of
      // which session is the "most recent" stream-start.
      const isStreamingNow = !!(local && typeof window.isStreaming === 'function' && window.isStreaming(srv.id));
      if (local && (isStreamingNow || local.updatedAt >= srv.updatedAt)) {
        // Local copy is at-or-newer than server — keep it but tag if we
        // know full content is bigger than what's cached, so selectChat
        // knows to hydrate on click.
        const listTruncated = local.messages && typeof srv.messageCount === 'number' && srv.messageCount > local.messages.length;
        const hasTruncated = local.messages && local.messages.some(m => m._truncated || (typeof m.content === 'string' && m.content.length >= 9_900));
        if (!isStreamingNow && (listTruncated || hasTruncated)) local._needsHydrate = true;
        merged.push(local);
      } else {
        // Server is newer or session is server-only. Build a metadata stub —
        // selectChat will hydrate the body when the user clicks in.
        const stub = {
          id: srv.id,
          title: srv.title,
          updatedAt: srv.updatedAt,
          createdAt: srv.createdAt || (local && local.createdAt) || srv.updatedAt,
          messageCount: srv.messageCount,
          messages: (local && local.messages) || [],
          _needsHydrate: true,
        };
        if (local) {
          stub.projectId = local.projectId;
          stub.compactedAt = local.compactedAt;
          if (local.archived) stub.archived = true;
        }
        merged.push(stub);
      }
    }

    // Local-only sessions (not on server yet — newly created before first save)
    for (const local of chats) {
      if (!seen.has(local.id)) merged.push(local);
    }

    merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    chats = merged;
    // If activeChat got replaced by a stub during the merge, swap the in-memory
    // pointer to the merged record so selectChat / renderMessages see the same
    // object that's in the chats[] array.
    if (activeChat) {
      const merged2 = chats.find(c => c.id === activeChat.id);
      if (merged2 && merged2 !== activeChat) activeChat = merged2;
    }
    saveChats();
    renderSidebar();
  } catch (e) {
    console.warn('[sync] Failed to fetch sessions from server:', e.message);
  }
}

async function syncProjectsFromServer() {
  try {
    const r = await fetch(`${API}/api/projects`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!r.ok) return;
    const list = await r.json();
    if (!Array.isArray(list)) return;
    // Server returns the full Project record; sidebar only needs id + name.
    projects = list.map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt }));
    try { window.projects = projects; } catch {}
    saveProjects();
    renderSidebar();
    // Status bar's project selector reads window.projects, so re-render
    // it now that the list is fresh.
    try { if (typeof window.updateStatusBar === 'function') window.updateStatusBar(); } catch {}
  } catch { /* leave cached snapshot */ }
}

// One-shot migration from the legacy sax_projects_v1 localStorage key.
// Reads any frontend-only projects the user created before the backend
// became the source of truth, posts them to the server, then clears the
// legacy key. Runs once per install.
async function migrateLegacyLocalStorageProjects() {
  if (localStorage.getItem('sax_projects_migrated_v1') === 'done') return;
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem('sax_projects_v1') || '[]'); } catch { legacy = []; }
  if (Array.isArray(legacy) && legacy.length > 0) {
    for (const p of legacy) {
      if (!p?.name) continue;
      try {
        await fetch(`${API}/api/projects/from-starter`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
          body: JSON.stringify({ name: p.name, description: '', agentIds: [] }),
        });
      } catch { /* one project failing shouldn't block the rest */ }
    }
  }
  try { localStorage.setItem('sax_projects_migrated_v1', 'done'); } catch {}
  try { localStorage.removeItem('sax_projects_v1'); } catch {}
  await syncProjectsFromServer();
}

async function hydrateChat(chat) {
  try {
    const res = await fetch(`${API}/api/sessions/${chat.id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!res.ok) { delete chat._needsHydrate; return; }
    const session = await res.json();
    // Preserve client-only fields the server doesn't know about.
    session.projectId = chat.projectId;
    session.compactedAt = chat.compactedAt;
    if (chat.archived) session.archived = true;
    // Mutate in place so the activeChat pointer (and any closures holding it)
    // stay valid. Replace messages, copy server fields.
    Object.assign(chat, session);
    delete chat._needsHydrate;
    saveChats();
    if (activeChat && activeChat.id === chat.id && window.renderMessages) renderMessages();
  } catch (e) {
    delete chat._needsHydrate;
    throw e;
  }
}
