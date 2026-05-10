// ── Settings: Conversation Ingest ──
//
// One-shot import of external chat history (ChatGPT / Claude exports etc.)
// into LAX memory. File picker → POST /api/memory/ingest with progress.

// ── Conversation Ingest ──

async function handleIngestFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const countEl = document.getElementById('ingest-file-count');
  const progressEl = document.getElementById('ingest-progress');
  const fillEl = document.getElementById('ingest-progress-fill');
  const labelEl = document.getElementById('ingest-progress-label');
  const resultEl = document.getElementById('ingest-result');

  if (countEl) countEl.textContent = fileList.length + ' file' + (fileList.length > 1 ? 's' : '') + ' selected';
  if (progressEl) progressEl.style.display = '';
  if (fillEl) fillEl.style.width = '0%';
  if (labelEl) labelEl.textContent = 'Uploading...';
  if (resultEl) resultEl.style.display = 'none';

  const form = new FormData();
  for (const file of fileList) {
    form.append('file', file);
  }

  try {
    const res = await fetch(API + '/api/memory/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + AUTH_TOKEN },
      body: form,
    });
    const data = await res.json();

    if (fillEl) fillEl.style.width = '100%';
    if (labelEl) labelEl.textContent = '100% — Complete';

    if (resultEl) {
      const fmtList = data.formats ? Object.entries(data.formats).map(function(e) { return e[0] + ': ' + e[1]; }).join(', ') : 'none';
      resultEl.innerHTML =
        '<div style="color:var(--accent);margin-bottom:8px">Ingest Complete</div>' +
        '<div>Conversations processed: <strong>' + (data.processed || 0) + '</strong></div>' +
        '<div>Skipped (already imported): <strong>' + (data.skipped || 0) + '</strong></div>' +
        '<div>Chunks created: <strong>' + (data.chunksCreated || 0) + '</strong></div>' +
        '<div>Errors: <strong>' + (data.errors || 0) + '</strong></div>' +
        '<div>Formats detected: ' + fmtList + '</div>';
      resultEl.style.display = '';
    }
  } catch (e) {
    if (fillEl) fillEl.style.width = '100%';
    if (fillEl) fillEl.style.background = 'var(--danger)';
    if (labelEl) labelEl.textContent = 'Failed';
    if (resultEl) {
      resultEl.innerHTML = '<div style="color:var(--danger)">Ingest failed: ' + (e.message || 'Unknown error') + '</div>';
      resultEl.style.display = '';
    }
  }
}
window.handleIngestFiles = handleIngestFiles;

