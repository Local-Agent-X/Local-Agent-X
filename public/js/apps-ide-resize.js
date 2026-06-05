// IDE panel resize — drag the gutters between chat | preview | files to
// resize the side panels. Widths persist to localStorage per-panel.
//
// The handle is a .ide-resize-handle sibling that knows its target panel id
// (data-resize-target) and which side of the target it sits on
// (data-resize-side: "right" means handle is to the right of the panel, so
// dragging right grows it; "left" means handle is to the left of the panel,
// so dragging right shrinks it).
(function(){
  const BOUNDS = {
    'ide-chat-panel':  { min: 240, max: 700, key: 'lax_ide_chat_w' },
    'ide-files-panel': { min: 200, max: 600, key: 'lax_ide_files_w' },
  };

  function restore(){
    for (const id in BOUNDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      const w = parseInt(localStorage.getItem(BOUNDS[id].key) || '0', 10);
      if (w >= BOUNDS[id].min && w <= BOUNDS[id].max) {
        el.style.width = w + 'px';
        el.style.minWidth = w + 'px';
      }
    }
  }

  function attach(handle){
    handle.addEventListener('pointerdown', (e) => {
      const targetId = handle.dataset.resizeTarget;
      const side = handle.dataset.resizeSide; // 'right' or 'left'
      const target = document.getElementById(targetId);
      const bounds = BOUNDS[targetId];
      if (!target || !bounds) return;
      // Don't try to drag a collapsed panel — handle is hidden via CSS but
      // belt-and-suspenders against weird race
      if (target.classList.contains('collapsed')) return;

      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('ide-resizing');

      const startX = e.clientX;
      const startW = target.getBoundingClientRect().width;

      function onMove(ev){
        const dx = ev.clientX - startX;
        // For a handle on the right of its target, drag-right grows the target.
        // For a handle on the left of its target, drag-right shrinks the target.
        let w = side === 'left' ? startW - dx : startW + dx;
        if (w < bounds.min) w = bounds.min;
        if (w > bounds.max) w = bounds.max;
        target.style.width = w + 'px';
        target.style.minWidth = w + 'px';
      }
      function onUp(){
        handle.releasePointerCapture(e.pointerId);
        handle.classList.remove('dragging');
        document.body.classList.remove('ide-resizing');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        const w = parseInt(target.style.width, 10);
        if (w) localStorage.setItem(bounds.key, String(w));
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    // Double-click resets to default
    handle.addEventListener('dblclick', () => {
      const targetId = handle.dataset.resizeTarget;
      const target = document.getElementById(targetId);
      const bounds = BOUNDS[targetId];
      if (!target || !bounds) return;
      target.style.width = '';
      target.style.minWidth = '';
      localStorage.removeItem(bounds.key);
    });
  }

  function init(){
    restore();
    document.querySelectorAll('.ide-resize-handle').forEach(attach);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
