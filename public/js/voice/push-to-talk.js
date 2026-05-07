// Push-to-talk gate for the browser voice frontend.
//
// One global state machine that decides whether the mic should be "open"
// (frames flow to the server) or "closed" (frames suppressed) based on a
// configurable mode + hotkey:
//
//   off            — always-on / VAD driven, identical to the original flow.
//   push-to-talk   — mic open only while the configured chord is held.
//   toggle         — tap chord to open, tap again to close.
//
// Usage:
//   PushToTalk.init({
//     onMicOpen:  () => { /* unmute mic */ },
//     onMicClose: () => { /* mute mic */   },
//   });
//   PushToTalk.setMode('push-to-talk');
//   PushToTalk.setChord({ code: 'Space', ctrl: false, alt: false, shift: false, meta: false });
//   PushToTalk.getState();   // 'open' | 'closed'
//
// Persists config to localStorage under `lax.voice.pushToTalk`.
// The actual key listener is global; it's a no-op when an <input>,
// <textarea>, or [contenteditable] element has focus so it never steals
// keystrokes from forms / the message composer.

(function () {
  'use strict';

  const STORAGE_KEY = 'lax.voice.pushToTalk';
  const VALID_MODES = ['off', 'push-to-talk', 'toggle'];

  const DEFAULT_CHORD = {
    code: 'Space',
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };

  const DEFAULT_CONFIG = {
    mode: 'off',
    chord: { ...DEFAULT_CHORD },
  };

  let _config = loadConfig();
  let _onMicOpen = null;
  let _onMicClose = null;
  let _onStateChange = null;
  // Internal gate state. In 'off' mode the gate is permanently 'open' so the
  // current always-on / VAD flow is byte-for-byte identical to today's
  // behavior. In ptt/toggle modes the gate flips based on the hotkey.
  let _gate = 'open';
  let _toggleHeld = false;     // true while the chord is currently held in toggle mode
  let _initialized = false;
  let _listeners = [];

  // ── Storage ──────────────────────────────────────────────────────────
  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_CONFIG, chord: { ...DEFAULT_CHORD } };
      const parsed = JSON.parse(raw);
      const mode = VALID_MODES.includes(parsed?.mode) ? parsed.mode : 'off';
      const chord = sanitizeChord(parsed?.chord) || { ...DEFAULT_CHORD };
      return { mode, chord };
    } catch {
      return { ...DEFAULT_CONFIG, chord: { ...DEFAULT_CHORD } };
    }
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_config));
    } catch { /* localStorage may be disabled — feature degrades silently */ }
  }

  function sanitizeChord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const code = typeof raw.code === 'string' ? raw.code : '';
    if (!code) return null;
    return {
      code,
      ctrl:  !!raw.ctrl,
      alt:   !!raw.alt,
      shift: !!raw.shift,
      meta:  !!raw.meta,
    };
  }

  // ── Chord matching / formatting ──────────────────────────────────────
  function chordMatches(chord, e) {
    if (!chord || !e) return false;
    if (chord.code !== e.code) return false;
    if (!!chord.ctrl  !== !!e.ctrlKey)  return false;
    if (!!chord.alt   !== !!e.altKey)   return false;
    if (!!chord.shift !== !!e.shiftKey) return false;
    if (!!chord.meta  !== !!e.metaKey)  return false;
    return true;
  }

  // Format a chord for display: "Ctrl+Shift+M", "Space", etc.
  function formatChord(chord) {
    if (!chord || !chord.code) return '(none)';
    const parts = [];
    if (chord.ctrl)  parts.push('Ctrl');
    if (chord.alt)   parts.push('Alt');
    if (chord.shift) parts.push('Shift');
    if (chord.meta)  parts.push('Meta');
    parts.push(prettyCode(chord.code));
    return parts.join('+');
  }

  // KeyA → A, Digit1 → 1, Space → Space, Slash → /, etc.
  function prettyCode(code) {
    if (!code) return '';
    if (code.startsWith('Key'))   return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const map = {
      Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Esc',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
      Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    };
    return map[code] || code;
  }

  // ── Focus guard ──────────────────────────────────────────────────────
  // Don't intercept the hotkey when the user is typing into an input,
  // textarea, or contenteditable element.
  function isTextInputFocused() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
    return false;
  }

  // ── Gate management ──────────────────────────────────────────────────
  function setGate(next) {
    if (next === _gate) return;
    _gate = next;
    try {
      if (next === 'open' && typeof _onMicOpen === 'function') _onMicOpen();
      if (next === 'closed' && typeof _onMicClose === 'function') _onMicClose();
    } catch (e) { console.warn('[push-to-talk] callback threw:', e); }
    if (typeof _onStateChange === 'function') {
      try { _onStateChange(next); } catch (e) { console.warn('[push-to-talk] onStateChange threw:', e); }
    }
    // Mirror to body class so any pure-CSS visual hooks can react.
    try {
      document.body.classList.toggle('lax-mic-hot', next === 'open' && _config.mode !== 'off');
      document.body.classList.toggle('lax-mic-muted', next === 'closed');
    } catch {}
  }

  // Compute the gate state from the current mode (independent of any held
  // key). Used when the mode/chord changes to immediately reflect the new
  // policy. push-to-talk default is 'closed' (key not held); toggle is
  // 'closed' (no toggle on yet); off is permanently 'open'.
  function recomputeGateForModeChange() {
    if (_config.mode === 'off') {
      setGate('open');
    } else if (_config.mode === 'push-to-talk') {
      // Until the next keydown we don't know if it's held — assume not.
      setGate('closed');
      _toggleHeld = false;
    } else if (_config.mode === 'toggle') {
      setGate('closed');
      _toggleHeld = false;
    }
  }

  // ── Key listeners ────────────────────────────────────────────────────
  function onKeyDown(e) {
    if (_config.mode === 'off') return;
    if (isTextInputFocused()) return;
    if (!chordMatches(_config.chord, e)) return;
    // Avoid Space scrolling, etc.
    e.preventDefault();
    if (_config.mode === 'push-to-talk') {
      if (e.repeat) return; // already held, don't refire
      setGate('open');
    } else if (_config.mode === 'toggle') {
      // Only react on the first keydown of a press, not auto-repeats.
      if (e.repeat) return;
      if (_toggleHeld) return;
      _toggleHeld = true;
      setGate(_gate === 'open' ? 'closed' : 'open');
    }
  }

  function onKeyUp(e) {
    if (_config.mode === 'off') return;
    // We don't focus-guard keyup as strictly — if the chord went down outside
    // an input but the user then focused one before releasing, we still need
    // to release the gate so it doesn't get stuck open.
    if (!chordMatches(_config.chord, e)) {
      // Modifier release: e.code is a modifier name, no full match. If we
      // were holding the chord by its code, release on that code.
      if (e.code !== _config.chord.code) return;
    }
    if (_config.mode === 'push-to-talk') {
      e.preventDefault();
      setGate('closed');
    } else if (_config.mode === 'toggle') {
      // Mark toggle key as released so the next keydown can flip again.
      _toggleHeld = false;
    }
  }

  // Window blur — if the user alt-tabs while the chord is held, we won't
  // get the keyup. Reset to a safe state.
  function onBlur() {
    if (_config.mode === 'push-to-talk' && _gate === 'open') setGate('closed');
    _toggleHeld = false;
  }

  // ── Public API ───────────────────────────────────────────────────────
  function init(opts) {
    if (_initialized) {
      // Allow callers to re-attach handlers (chat.js may run init again on
      // hot reload). Update the callbacks but keep the listeners set up.
      _onMicOpen = (opts && opts.onMicOpen) || _onMicOpen;
      _onMicClose = (opts && opts.onMicClose) || _onMicClose;
      _onStateChange = (opts && opts.onStateChange) || _onStateChange;
      return;
    }
    _onMicOpen = (opts && opts.onMicOpen) || null;
    _onMicClose = (opts && opts.onMicClose) || null;
    _onStateChange = (opts && opts.onStateChange) || null;

    const kd = (e) => onKeyDown(e);
    const ku = (e) => onKeyUp(e);
    const blur = () => onBlur();
    document.addEventListener('keydown', kd, { capture: true });
    document.addEventListener('keyup', ku, { capture: true });
    window.addEventListener('blur', blur);
    _listeners.push(
      () => document.removeEventListener('keydown', kd, { capture: true }),
      () => document.removeEventListener('keyup', ku, { capture: true }),
      () => window.removeEventListener('blur', blur),
    );

    _initialized = true;
    // Initialize gate state to match the loaded config so consumers see
    // the right starting state.
    recomputeGateForModeChange();
  }

  function destroy() {
    _listeners.forEach((off) => { try { off(); } catch {} });
    _listeners = [];
    _initialized = false;
  }

  function getConfig() {
    return { mode: _config.mode, chord: { ..._config.chord } };
  }

  function setMode(mode) {
    if (!VALID_MODES.includes(mode)) return;
    if (mode === _config.mode) return;
    _config.mode = mode;
    saveConfig();
    recomputeGateForModeChange();
  }

  function setChord(chord) {
    const next = sanitizeChord(chord);
    if (!next) return;
    _config.chord = next;
    saveConfig();
    // Changing the chord doesn't itself flip the gate, but reset the
    // toggle latch so a stale "key held" state doesn't carry over.
    _toggleHeld = false;
    if (_config.mode === 'push-to-talk' && _gate === 'open') {
      // The currently-held key won't match the new chord on keyup; close.
      setGate('closed');
    }
  }

  function getState() { return _gate; }

  function getMode() { return _config.mode; }

  window.PushToTalk = {
    init,
    destroy,
    setMode,
    setChord,
    getConfig,
    getMode,
    getState,
    formatChord,
    chordMatches,
    sanitizeChord,
  };
})();
