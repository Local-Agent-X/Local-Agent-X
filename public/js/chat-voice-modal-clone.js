// ── Chat: Add Clone Modal (zero-shot voice) ──
//
// Modal for adding a zero-shot voice clone. Posts to the PRIMARY clone
// engine (VoxCPM, /api/voices/voxcpm); the sidecar auto-transcribes the
// clip. Single-step: name + sample upload.

function openAddCloneModal() {
  const existing = document.getElementById('add-clone-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'add-clone-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg, #fff);color:var(--text, #000);border:1px solid var(--border, #ccc);border-radius:10px;padding:24px;max-width:480px;width:92%">
      <h3 style="margin:0 0 6px;font-size:1.1rem">Clone a voice</h3>
      <p style="margin:0 0 14px;color:var(--muted, #666);font-size:.83rem">Upload a clean 10-30s WAV/MP3 of one person speaking. VoxCPM clones the voice in real time — no training step needed. Local-only, nothing leaves this machine.</p>
      <div style="margin-bottom:12px">
        <label style="display:block;font-size:.78rem;color:var(--muted, #666);margin-bottom:4px">Voice name</label>
        <input id="acb-name" type="text" placeholder="My Voice" style="width:100%;padding:8px;border:1px solid var(--border, #ccc);border-radius:6px;font-size:.9rem"/>
      </div>
      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.78rem;color:var(--muted, #666);margin-bottom:4px">Reference audio (10-30s recommended)</label>
        <input id="acb-file" type="file" accept="audio/*" style="width:100%;font-size:.85rem"/>
      </div>
      <div id="acb-status" style="font-size:.8rem;color:var(--muted, #666);margin-bottom:12px;min-height:1em"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button id="acb-cancel" type="button" style="padding:8px 14px;border:1px solid var(--border, #ccc);background:transparent;color:var(--text, #000);border-radius:6px;cursor:pointer">Cancel</button>
        <button id="acb-upload" type="button" style="padding:8px 14px;border:none;background:#3498db;color:#fff;border-radius:6px;cursor:pointer">Upload &amp; install</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.getElementById('acb-cancel').onclick = () => modal.remove();

  const status = document.getElementById('acb-status');
  const setStatus = (msg, isError) => { status.textContent = msg; status.style.color = isError ? '#c0392b' : 'var(--muted, #666)'; };

  document.getElementById('acb-upload').onclick = async () => {
    const name = (document.getElementById('acb-name').value || '').trim() || 'My Voice';
    const file = document.getElementById('acb-file').files[0];
    if (!file) { setStatus('Pick an audio file first.', true); return; }
    if (file.size > 18 * 1024 * 1024) { setStatus('File too big (max ~18MB).', true); return; }
    setStatus('Uploading… (transcribing the clip takes a few seconds)', false);
    try {
      const arrayBuf = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      const b64 = btoa(binary);
      const r = await apiFetch('/api/voices/voxcpm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, audio_b64: b64 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus('Failed: ' + (data.error || data.detail || ('HTTP ' + r.status)), true); return; }
      await refreshClonedVoices();
      // Auto-select the new voice
      const newId = 'vx:' + data.id;
      localStorage.setItem('lax_voice', newId);
      const sel = document.getElementById('voice-quick-select');
      if (sel) sel.value = newId;
      quickSwitchVoice(newId);
      // Replace the upload button with a clear "next step" prompt so the
      // user knows exactly what to do, instead of the modal vanishing.
      const cancelBtn = document.getElementById('acb-cancel');
      const uploadBtn = document.getElementById('acb-upload');
      if (uploadBtn) uploadBtn.style.display = 'none';
      if (cancelBtn) {
        cancelBtn.textContent = 'Got it — close this';
        cancelBtn.style.background = '#27ae60';
        cancelBtn.style.color = '#fff';
        cancelBtn.style.border = 'none';
      }
      setStatus(`✓ Installed "${data.name || name}". Close this, click the mic button, and speak.`, false);
    } catch (e) { setStatus('Failed: ' + e.message, true); }
  };
}

// Back-compat alias — callers still reference the Chatterbox-era name.
function openAddChatterboxModal() { openAddCloneModal(); }
