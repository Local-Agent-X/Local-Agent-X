// ── App Shell: a project's documents in the sidebar ──
// "Add files" on a project row uploads into the project's documents folder;
// an expanded project lists what is there. The server indexes the folder, so
// the project's chats can search an added file a moment later.

const projectDocsCache = {};
const projectDocsLoading = new Set();
const PROJECT_DOCS_SHOWN = 6;
/** The agent saves into the folder too; a list older than this is refetched
 *  the next time the project is drawn expanded. */
const PROJECT_DOCS_STALE_MS = 30000;

function addProjectFiles(projectId, e) {
  e?.stopPropagation();
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.pdf,.docx,.pptx,.md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm';
  input.onchange = async () => {
    if (!input.files || input.files.length === 0) return;
    const form = new FormData();
    for (const f of input.files) form.append('file', f, f.name);
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: 'POST', body: form, headers: {} });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || (body.refused && body.refused.length)) {
        alert(body.error ? `${body.error}${body.refused?.length ? `\n\nNot added: ${body.refused.join(', ')}` : ''}` : `Upload failed (HTTP ${res.status}).`);
      }
    } catch (err) {
      alert('Failed to add files: ' + (err?.message || err));
    }
    expandedProjects.add(projectId);
    await loadProjectDocs(projectId);
  };
  input.click();
}

async function loadProjectDocs(projectId) {
  if (projectDocsLoading.has(projectId)) return;
  projectDocsLoading.add(projectId);
  try {
    const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
    // A failure is cached too, so a redraw does not refetch in a loop.
    projectDocsCache[projectId] = res.ok ? { ...(await res.json()), at: Date.now() } : { failed: true, at: Date.now() };
  } catch {
    projectDocsCache[projectId] = { failed: true, at: Date.now() };
  }
  projectDocsLoading.delete(projectId);
  renderProjects();
}

/** The documents row inside an expanded project; loads the list on first view. */
function renderProjectDocs(projectId) {
  const docs = projectDocsCache[projectId];
  if (!docs || Date.now() - docs.at > PROJECT_DOCS_STALE_MS) {
    if (expandedProjects.has(projectId)) setTimeout(() => loadProjectDocs(projectId), 0);
    if (!docs) return '';
  }
  if (docs.failed) return '';
  const files = docs.files || [];
  const names = files.slice(0, PROJECT_DOCS_SHOWN).map(f => `<div class="project-doc" title="${esc(f.name)}">${esc(f.name)}</div>`).join('');
  const more = files.length > PROJECT_DOCS_SHOWN ? `<div class="project-doc muted">+${files.length - PROJECT_DOCS_SHOWN} more</div>` : '';
  return `
    <div class="project-docs" title="${esc(docs.folder || '')}">
      <div class="project-docs-head">Documents${files.length ? ` · ${files.length}` : ''}
        <button class="project-docs-add" onclick="addProjectFiles('${projectId}',event)">Add files</button>
      </div>
      ${files.length ? names + more : '<div class="project-doc muted">None yet. Files added here are searchable in this project’s chats.</div>'}
    </div>
  `;
}
