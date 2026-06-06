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
    const serverList = await res.json(); // [{id, title, updatedAt, messageCount, projectId}]

    const localMap = new Map(chats.map(c => [c.id, c]));
    const merged = [];
    const seen = new Set();
    const deletedIds = getDeletedIds();

    for (const srv of serverList) {
      seen.add(srv.id);
      if (deletedIds[srv.id]) continue;
      const local = localMap.get(srv.id);
      // Mid-stream protection: NEVER replace the local chat object while the
      // session is active — streaming OR mid-finalize (status off 'streaming'
      // but the turn isn't persisted server-side yet). Replacing it orphans the
      // streamChat closure reference in sendMessage and drops the unpersisted
      // user message. Per-session via the store so concurrent streams (main
      // chat + IDE app-builder) each protect their own object.
      const isActiveNow = !!(local && typeof window.isActive === 'function' && window.isActive(srv.id));
      if (local && (isActiveNow || local.updatedAt >= srv.updatedAt)) {
        // Local copy is at-or-newer than server — keep it but tag if we
        // know full content is bigger than what's cached, so selectChat
        // knows to hydrate on click.
        const listTruncated = local.messages && typeof srv.messageCount === 'number' && srv.messageCount > local.messages.length;
        const hasTruncated = local.messages && local.messages.some(m => m._truncated || (typeof m.content === 'string' && m.content.length >= 9_900));
        if (!isActiveNow && (listTruncated || hasTruncated)) local._needsHydrate = true;
        local.serverBacked = true; // confirmed present on the server this sync
        // Heal a local copy that lost its projectId (older cache, or a prior
        // sync that dropped it) from the server's now-durable value. Local is
        // at-or-newer, so don't overwrite an existing local projectId.
        if (srv.projectId && !local.projectId) local.projectId = srv.projectId;
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
          serverBacked: true, // present in the server list this sync
        };
        // Server's projectId is now durable and authoritative; fall back to
        // the local value only for sessions saved before the backend tracked
        // it. This is the fix for the sync-drops-projectId bug that silently
        // unscoped project chats.
        stub.projectId = srv.projectId || (local && local.projectId) || undefined;
        if (local) {
          stub.compactedAt = local.compactedAt;
          if (local.archived) stub.archived = true;
        }
        merged.push(stub);
      }
    }

    // Sessions absent from the server response. A chat the server has NEVER
    // confirmed is a genuine new local draft (created but not yet saved) — keep
    // it. But a chat we previously saw from the server that's now missing was
    // deleted server-side (or the backend was reset) — prune it instead of
    // leaving a phantom that opens empty. We only get here on a 200 with the
    // server as source of truth, so this is safe and self-healing: if the
    // session really still exists, the next sync re-adds it as a stub.
    for (const local of chats) {
      if (seen.has(local.id)) continue;
      if (local.serverBacked) continue; // orphaned — server dropped it; drop locally too
      merged.push(local);
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

// One-shot migration from the legacy lax_projects_v1 localStorage key.
// Reads any frontend-only projects the user created before the backend
// became the source of truth, posts them to the server, then clears the
// legacy key. Runs once per install.
async function migrateLegacyLocalStorageProjects() {
  if (localStorage.getItem('lax_projects_migrated_v1') === 'done') return;
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem('lax_projects_v1') || '[]'); } catch { legacy = []; }
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
  try { localStorage.setItem('lax_projects_migrated_v1', 'done'); } catch {}
  try { localStorage.removeItem('lax_projects_v1'); } catch {}
  await syncProjectsFromServer();
}

async function hydrateChat(chat) {
  try {
    const res = await fetch(`${API}/api/sessions/${chat.id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!res.ok) { delete chat._needsHydrate; return; }
    const session = await res.json();
    // projectId is now server-durable: prefer the local value (may be a fresh
    // move not yet synced), fall back to the server's so a null local can't
    // wipe the binding. compactedAt stays client-only.
    session.projectId = chat.projectId || session.projectId;
    session.compactedAt = chat.compactedAt;
    if (chat.archived) session.archived = true;
    // Don't let a stale server snapshot overwrite messages the client just
    // produced locally. A turn's user message + finalized assistant live only
    // in memory until the server persists them; a hydrate that races that
    // window returns fewer messages than we hold and would blow away the
    // in-flight turn (question vanishes, reply re-anchors to the bottom). When
    // the local copy is at-or-ahead of the fetched snapshot, keep local
    // messages and the newer timestamp.
    const localMsgs = Array.isArray(chat.messages) ? chat.messages : [];
    const serverMsgs = Array.isArray(session.messages) ? session.messages : [];
    if ((chat.updatedAt || 0) > (session.updatedAt || 0) || localMsgs.length > serverMsgs.length) {
      delete session.messages;
      session.updatedAt = Math.max(chat.updatedAt || 0, session.updatedAt || 0);
    }
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
