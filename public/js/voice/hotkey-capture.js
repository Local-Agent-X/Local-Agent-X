// Hotkey-capture modal for the push-to-talk feature.
//
// Exports HotkeyCapture.open() which returns a Promise resolving to a
// canonical chord object { code, ctrl, alt, shift, meta } or null on
// cancel/escape.
//
// The modal listens for the next non-modifier keydown and snapshots the
// currently-held modifiers. Modifier-only keys (Ctrl, Alt, Shift, Meta)
// don't terminate capture — the user can press Ctrl, then Shift, then M
// to record Ctrl+Shift+M. Escape cancels.

(function () {
  'use strict';

  const MODIFIER_CODES = new Set([
    'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight',
    'MetaLeft', 'MetaRight',
    'OSLeft', 'OSRight',
  ]);

  function open() {
    return new Promise((resolve) => {
      // Build modal lazily so we never paint anything until the user opens it.
      const overlay = document.createElement('div');
      overlay.id = 'hotkey-capture-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Capture hotkey');
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:10000',
        'background:rgba(0,0,0,0.7)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'font-family:var(--mono, monospace)',
      ].join(';');

      const dialog = document.createElement('div');
      dialog.style.cssText = [
        'background:#0d0d18',
        'border:1px solid var(--accent, #00ff41)',
        'border-radius:10px',
        'padding:24px 32px',
        'min-width:340px',
        'text-align:center',
        'color:var(--text, #fff)',
        'box-shadow:0 8px 40px rgba(0,0,0,0.6)',
      ].join(';');

      const title = document.createElement('div');
      title.textContent = 'Press a key';
      title.style.cssText = 'font-size:1.05rem;color:var(--accent,#00ff41);margin-bottom:6px;letter-spacing:.5px';

      const hint = document.createElement('div');
      hint.textContent = 'Hold modifiers then press a letter, digit, or symbol. Esc to cancel.';
      hint.style.cssText = 'font-size:.72rem;color:var(--muted,#888);margin-bottom:18px';

      const preview = document.createElement('div');
      preview.textContent = '...';
      preview.style.cssText = [
        'font-size:1.4rem',
        'padding:14px 8px',
        'border:1px dashed var(--accent,#00ff41)',
        'border-radius:8px',
        'background:#06060c',
        'min-height:1em',
        'letter-spacing:.5px',
      ].join(';');

      const actions = document.createElement('div');
      actions.style.cssText = 'margin-top:18px;display:flex;gap:10px;justify-content:center';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = [
        'background:transparent',
        'border:1px solid var(--border,#333)',
        'color:var(--text,#fff)',
        'border-radius:6px',
        'padding:7px 18px',
        'cursor:pointer',
        'font-family:inherit',
        'font-size:.78rem',
      ].join(';');

      actions.appendChild(cancelBtn);

      dialog.appendChild(title);
      dialog.appendChild(hint);
      dialog.appendChild(preview);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      let resolved = false;
      function cleanup(result) {
        if (resolved) return;
        resolved = true;
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('keyup', onKeyUp, true);
        try { document.body.removeChild(overlay); } catch {}
        resolve(result);
      }

      function onKeyDown(e) {
        // Prevent modal from leaking keystrokes (e.g. Space scrolling under it,
        // Ctrl+S saving the page, etc.) while we're capturing.
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'Escape') {
          cleanup(null);
          return;
        }

        // While only modifiers are held, render a live preview so the user
        // sees what's being captured. Don't commit yet.
        if (MODIFIER_CODES.has(e.code)) {
          const partial = formatPartial(e);
          preview.textContent = partial + '+...';
          return;
        }

        // Got the terminating key. Snapshot the chord and resolve.
        const chord = {
          code: e.code,
          ctrl: !!e.ctrlKey,
          alt: !!e.altKey,
          shift: !!e.shiftKey,
          meta: !!e.metaKey,
        };
        preview.textContent = formatChord(chord);
        // Brief pause so the user sees what landed before the modal closes.
        setTimeout(() => cleanup(chord), 220);
      }

      function onKeyUp(e) {
        e.preventDefault();
        e.stopPropagation();
      }

      cancelBtn.addEventListener('click', () => cleanup(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);
    });
  }

  // Display helpers — duplicated here (rather than importing from
  // push-to-talk.js) so this module is self-contained and can run before
  // push-to-talk loads.
  function formatPartial(e) {
    const parts = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.altKey)   parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey)  parts.push('Meta');
    return parts.length ? parts.join('+') : '(modifier)';
  }
  function formatChord(chord) {
    const parts = [];
    if (chord.ctrl)  parts.push('Ctrl');
    if (chord.alt)   parts.push('Alt');
    if (chord.shift) parts.push('Shift');
    if (chord.meta)  parts.push('Meta');
    parts.push(prettyCode(chord.code));
    return parts.join('+');
  }
  function prettyCode(code) {
    if (!code) return '';
    if (code.startsWith('Key'))   return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const map = {
      Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Esc',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    };
    return map[code] || code;
  }

  window.HotkeyCapture = { open };
})();
