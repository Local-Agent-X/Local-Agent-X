// ── Settings: Uploads Storage (Media tab) ──
//
// Surfaces how much disk the chat uploads folder (~/.lax/uploads) is using,
// with a Clear button and — in the desktop app only — a button to reveal the
// folder in the OS file manager. Storage is unbounded by design; this just
// makes it visible and prunable instead of silently growing.

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function loadUploadsStats() {
  const el = document.getElementById('uploads-stats');
  if (!el) return;
  const openBtn = document.getElementById('uploads-open-folder');
  if (openBtn) openBtn.style.display = window.desktop ? '' : 'none';
  try {
    const res = await apiFetch('/api/uploads/stats');
    const d = await res.json();
    el.textContent = `${d.count} file${d.count === 1 ? '' : 's'} · ${formatBytes(d.bytes)}`;
  } catch {
    el.textContent = 'Could not read uploads folder.';
  }
}

async function clearUploads(btn) {
  if (!confirm('Delete all uploaded images and files? Older chats may show missing images. This cannot be undone.')) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Clearing…'; }
  try {
    await apiFetch('/api/uploads', { method: 'DELETE' });
  } catch (e) {
    console.warn('[uploads] clear failed', e);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Clear all uploads'; }
  loadUploadsStats();
}

function openUploadsFolder() {
  window.desktop?.openUploadsFolder?.();
}
