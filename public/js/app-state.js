// ── App Shell: Sidebar state + localStorage persistence ──
// State vars are declared with `let` at top-level so they live in the shared
// classic-script scope — other split files (app-sync, app-sidebar-actions,
// app-sidebar-render, app.js) read and reassign them by bare identifier.
// Persistence helpers live here too so all storage keys are in one place.

// One-shot cleanup: tag system was removed 2026-05-26. Drop the orphaned
// localStorage keys so existing users don't carry dead state forever.
try { localStorage.removeItem('sax_chat_tags'); localStorage.removeItem('sax_all_tags'); } catch {}

let chats = loadChatsFromCache(); // Start with cache, then fetch from server
let projects = loadProjects();
// Mirror to window so cross-script consumers (chat-status-bar's project
// selector) can read the live list without redoing the API call.
try { window.projects = projects; window.activeChat = null; } catch {}
let activeChat = null;
let expandedProjects = new Set();
let projectsCollapsed = (() => { try { return localStorage.getItem('sax_projects_collapsed') === '1'; } catch { return false; } })();
let projectLastAccessed = (() => { try { return JSON.parse(localStorage.getItem('sax_project_last_accessed') || '{}'); } catch { return {}; } })();
let mobileSectionCollapsed = (() => { try { return localStorage.getItem('sax_mobile_collapsed') === '1'; } catch { return false; } })();
function saveProjectsCollapsed() { try { localStorage.setItem('sax_projects_collapsed', projectsCollapsed ? '1' : '0'); } catch {} }
function saveProjectLastAccessed() { try { localStorage.setItem('sax_project_last_accessed', JSON.stringify(projectLastAccessed)); } catch {} }
function saveMobileSectionCollapsed() { try { localStorage.setItem('sax_mobile_collapsed', mobileSectionCollapsed ? '1' : '0'); } catch {} }
function touchProject(id) { if (!id) return; projectLastAccessed[id] = Date.now(); saveProjectLastAccessed(); }
let serverSyncing = false; // Prevent save loops
let chatSearchQuery = ''; // Chat search filter
let pinnedChatIds = loadPinnedChats(); // Pinned chat IDs

function loadPinnedChats() { try { return JSON.parse(localStorage.getItem('sax_pinned_chats') || '[]'); } catch { return []; } }
function savePinnedChats() { localStorage.setItem('sax_pinned_chats', JSON.stringify(pinnedChatIds)); }

// Cache-only load (instant, for page load)
function loadChatsFromCache() { try { return JSON.parse(localStorage.getItem('sax_chats_v2') || '[]'); } catch { return []; } }

// Save: write to localStorage immediately, push to server in background
function saveChats() {
  // Save chat metadata + last 10 messages per chat to localStorage. Cap per-message
  // content at 10_000 chars (from the original 500) — long-form LLM replies were being
  // silently truncated mid-sentence, and on refresh the truncated local version was
  // preferred over the full server version. Mark truncated messages with _truncated
  // so the sync merge knows to prefer the server copy.
  const PER_MSG_CAP = 10_000;
  const toSave = chats.map(c => {
    const rec = {
      id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      messages: c.messages.slice(-10).map(m => {
        const raw = m.content || "";
        const truncated = raw.length > PER_MSG_CAP;
        const content = truncated ? raw.slice(0, PER_MSG_CAP) : raw;
        const base = { role: m.role, content };
        if (truncated) base._truncated = true;
        if (m.attachments) base.attachments = m.attachments.map(a => {
          // Persist `url` (server-hosted, small string) so images survive
          // reload. The original code stripped url + dataUrl, leaving only
          // {name,size,type,isImage} — which makes addMessageEl fall through
          // to the placeholder badge instead of rendering the image.
          // dataUrl is intentionally NOT persisted because it can be MB
          // each (data:image/png;base64,…) and would blow localStorage quota.
          // If the upload completed, we have `url`; if it failed, we have
          // nothing and the badge fallback is correct.
          const out = { name: a.name, size: a.size, type: a.type, isImage: a.isImage };
          if (a.url) out.url = a.url;
          return out;
        });
        return base;
      }),
    };
    // Persist client-only flags that don't live on the server session JSON.
    // Without these, archive/unarchive and project assignment vanished on reload.
    if (c.archived) rec.archived = true;
    if (c.projectId) rec.projectId = c.projectId;
    if (c.compactedAt) rec.compactedAt = c.compactedAt;
    // Remember whether this chat was ever confirmed by the server. The sync
    // merge uses it to tell a genuinely-new local draft (keep) apart from a
    // chat the server has since dropped (prune) — see syncChatsFromServer.
    if (c.serverBacked) rec.serverBacked = true;
    return rec;
  });
  try {
    localStorage.setItem('sax_chats_v2', JSON.stringify(toSave));
  } catch (e) {
    // Quota exceeded — prune oldest chats and retry
    console.warn('[storage] Quota exceeded, pruning old chats');
    while (toSave.length > 5) { toSave.pop(); }
    try { localStorage.setItem('sax_chats_v2', JSON.stringify(toSave)); } catch {}
  }
}

// Projects are backed by the server (ProjectStore) post-L6 — same source
// the agents page sees. Sidebar reads /api/projects on boot and keeps a
// local snapshot for synchronous render. Mutations hit the backend then
// refresh the snapshot.
function loadProjects() {
  // Synchronous bootstrap from localStorage cache so the first render
  // isn't empty. Server sync replaces this within a few hundred ms.
  try { return JSON.parse(localStorage.getItem('sax_projects_cache_v1') || '[]'); } catch { return []; }
}
function saveProjects() {
  // Cache the latest server snapshot so first paint after reload is
  // populated. Not the source of truth.
  try { localStorage.setItem('sax_projects_cache_v1', JSON.stringify(projects)); } catch {}
}

// Tombstones: track deleted session IDs so sync doesn't resurrect them.
// Integration sessions (wa-/tg-/sms-) are protected — they drive the
// Messaging panel, not Conversations, and "clear sidebar" semantics
// should never affect them. Filter on every read so stale bad tombstones
// from earlier versions self-heal without a migration.
function _isIntegrationSessionId(id) {
  return typeof id === 'string' && (id.startsWith('wa-') || id.startsWith('tg-') || id.startsWith('sms-'));
}
function getDeletedIds() {
  try {
    const raw = JSON.parse(localStorage.getItem('sax_deleted_sessions') || '{}');
    for (const k of Object.keys(raw)) { if (_isIntegrationSessionId(k)) delete raw[k]; }
    return raw;
  } catch { return {}; }
}
function markDeleted(id) {
  if (_isIntegrationSessionId(id)) return; // never tombstone integrations
  const deleted = getDeletedIds();
  deleted[id] = Date.now();
  // Prune tombstones older than 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(deleted)) { if (v < cutoff) delete deleted[k]; }
  localStorage.setItem('sax_deleted_sessions', JSON.stringify(deleted));
}
function isDeleted(id) { return !!getDeletedIds()[id]; }
