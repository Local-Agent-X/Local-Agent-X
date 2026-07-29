// ── The live-turn indicator: the signal, and the phrases that express it ──
//
// Themed "thinking" status phrases for Agent X — covert-operative flavor, the
// single source for the chat thinking indicator and the IDE status label.
// Phrases are stored WITHOUT a trailing ellipsis; the blinking dots in the
// indicator (or the appended "…" in the IDE label) supply it.
//
// The signal those phrases animate to lives here as well, because it is the
// same question the toolbar STREAMING chip asks (updateStreamUI in
// chat-uploads.js reads window.streamActivitySignal): what is the turn on
// screen ACTUALLY doing? Both moving affordances used to invent their own
// answer — the chip painted one boolean, the phrase rotated on a blind 3.8s
// timer — so both animated identically whether 34 tools were running or the
// server's event loop had been dead for two minutes, which is what taught
// users the motion means nothing. One derivation, three states:
//   flowing  visible output landed within STREAM_IDLE_MS
//   working  nothing visible for a while, but the op is provably alive and we
//            can usually name what it is doing
//   silent   nothing visible AND no proof of life — the animation stops
//            rather than keep implying progress
// Two clocks feed that, and they are never interchangeable: lastContentMs
// answers "is anything on SCREEN", lastActivityMs answers "is the op ALIVE".
// A five-minute build is content-stale and alive; a dead server is neither.
// The answer speaks for exactly one turn — the one in the chat on screen — so
// only that turn's own indicator wears it (see ownsIndicator).
// Every read is O(1): the chip derives this on EVERY store mutation.
(function () {
  var PHRASES = [
    // Core ops
    'Decrypting', 'Deciphering', 'Surveilling', 'Reconnoitering', 'Triangulating',
    'Shadowing', 'Intercepting', 'Profiling', 'Decoding', 'Infiltrating',
    'Investigating', 'Tailing', 'Scrambling', 'Extracting', 'Authenticating', 'Encrypting',
    // Field chatter
    'Gathering intel', 'Working the angles', 'Consulting the dossier', 'Connecting the dots',
    'Running recon', 'Reading the intercepts', 'Chasing the lead', 'Cross-checking the files',
    'Tapping the line', 'Sweeping for bugs', 'Following the trail', 'Working a hunch',
    'Pulling the files', 'Running the plates', 'Dusting for prints', 'Combing the records',
    'Tracing the signal', 'Marking the target', 'Verifying the source', 'Checking the wire',
    // Deep cover
    'Going dark', 'Cracking the cipher', 'Casing the perimeter', 'Meeting the asset',
    'Activating the network', 'Compiling the brief', 'Briefing command', 'Securing the channel',
    'Establishing comms', 'Awaiting the dead drop', 'Decrypting the transmission',
    'Running it up the chain',
    // Cheeky
    'Enhancing', 'Burning after reading', 'Need-to-know', 'Eyes only', 'Hiding in plain sight',
    'Trust no one', 'Following the money', 'Blending in', 'Cover intact',
    'This message will self-destruct'
  ];

  // Single source of truth — also consumed by the phrase-rain background.
  window.THINKING_PHRASES = PHRASES;

  // Silence gets ONE line, not a rotation. A frozen phrase reads as a state
  // the operative is IN; a cycling one would keep implying fresh progress,
  // which is the exact lie this indicator used to tell.
  var SILENT_PHRASE = 'Radio silence';

  function pick(exclude) {
    var p = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    if (exclude && p === exclude && PHRASES.length > 1) return pick(exclude);
    return p;
  }

  // ── Signal ──
  // Proof of life is store.lastActivityMs — the watchdog's own field, bumped
  // by every server event including the 20s op_heartbeat. Two missed beats is
  // real silence, and 45s admits the gap BEFORE the 60s stuck-stream watchdog
  // starts its recovery replay (chat-ws.js), so the indicator narrates the
  // problem instead of trailing the fix.
  var SIGNAL_STALE_MS = 45000;
  // op_heartbeat's optional turn shape (phase / activeTool) is broadcast-only:
  // the store's reducer folds the beat into its default case and keeps nothing
  // but the activity clock. subscribeAll still hands over the raw event, so the
  // newest beat is parked ON THE STORE'S OWN ENTRY, under the field named here.
  // Not in a sessionId-keyed map of our own: ChatStreamStore exists because
  // five parallel per-session maps drifted apart and took the stream/stop/badge
  // bugs with them, and a sixth one living in a themed-phrases file would be
  // that same bug wearing a new hat. Riding the entry, the beat is bounded by
  // the store's pruneEntries, and it can only ever be LABELLING — liveness is
  // judged by lastActivityMs above, never by how recent this beat is.
  var BEAT_FIELD = '_signalBeat';
  // `phase` is a wire lane name (heartbeat.ts sends 'stream' / 'reasoning',
  // and 'tool' only alongside an activeTool that already names it); anything
  // else is dropped rather than shown to a user as a raw token.
  var PHASE_ACTIVITY = { stream: 'writing', reasoning: 'thinking' };

  // Park each beat on its entry while the raw event is still in hand, and drop
  // it on `done` so a finished turn stops holding it. Registration order
  // against chat-uploads.js's repaint subscriber is NOT load-bearing: the
  // reducer has already set lastActivityMs before any subscriber runs, so the
  // STATE is right either way, and a beat parked after that repaint only means
  // the label carries the previous beat's tool name until the 3s chip tick.
  try {
    ChatStreamStore.subscribeAll(function (sessionId, entry, event) {
      if (!entry || !event) return;
      if (event.type === 'op_heartbeat') {
        entry[BEAT_FIELD] = {
          opId: event.opId || null,
          phase: event.phase || null,
          activeTool: event.activeTool || null,
        };
      } else if (event.type === 'done') {
        entry[BEAT_FIELD] = null;
      }
    });
  } catch {}

  // What the turn is busy with, or null when nothing can honestly name it.
  // Local tool events win over the beat: a start with nothing after it is
  // running RIGHT NOW, where a beat can be 20s old. Once that tail closes the
  // beat's activeTool is the better answer anyway — heartbeat.ts pairs
  // start↔end across parallel batches, which this O(1) tail check cannot.
  function currentActivity(store) {
    var events = store.toolEvents || [];
    var newest = events[events.length - 1];
    if (newest && newest.type === 'start' && newest.name) return newest.name;
    var beat = store[BEAT_FIELD];
    // Only a beat naming the entry's CURRENT op may label it — one left over
    // from the previous turn would describe work that is already over. This is
    // also what makes a parked beat safe across the events that DON'T clear it:
    // startTurn nulls opId, a takeover sets a new one, and `done` nulls it
    // again, so a stale beat can never match and can never speak.
    if (!beat || !beat.opId || beat.opId !== store.opId) return null;
    return beat.activeTool || PHASE_ACTIVITY[beat.phase] || null;
  }

  // Signal for the turn in the chat the user is LOOKING at (the same
  // resolution updateStreamUI uses). 'off' when no turn is in flight here.
  window.streamActivitySignal = function (sessionId) {
    var sid = sessionId || (window.activeChat ? window.activeChat.id : null);
    if (!sid || typeof ChatStreamStore === 'undefined' || !ChatStreamStore.isStreaming(sid)) {
      return { state: 'off', label: '', activity: null };
    }
    var store = ChatStreamStore.get(sid);
    if (!store) return { state: 'flowing', label: 'STREAMING', activity: null };
    // isContentIdle is chat-render-artifacts.js's — the same predicate that
    // decides whether the live bubble shows its idle indicator, so the chip,
    // the phrase and the bubble can never disagree about what "nothing is
    // arriving" means. It REFUSES to judge an entry with no content clock at
    // all (its `!!store.lastContentMs` guard), because the finalize path
    // synthesizes exactly such an entry to stop a terminal paint rendering
    // idle. Taking that refusal as "definitely flowing" is what made 'silent'
    // unreachable on every ADOPTED turn: a tab that never ran startTurn learns
    // the turn from chat_op_started / approval_requested, which bump
    // lastActivityMs and never lastContentMs — so the tab a user opens BECAUSE
    // the turn looked stuck was the one tab that could never say NO SIGNAL.
    // Nothing having ever landed is the strongest form of nothing arriving, so
    // ask the predicate only when there is a content clock for it to judge.
    var contentIdle = store.lastContentMs ? isContentIdle(store) : true;
    if (!contentIdle) return { state: 'flowing', label: 'STREAMING', activity: null };
    if (Date.now() - (store.lastActivityMs || 0) > SIGNAL_STALE_MS) {
      return { state: 'silent', label: 'NO SIGNAL', activity: null };
    }
    var activity = currentActivity(store);
    return {
      state: 'working',
      label: activity ? 'WORKING · ' + String(activity).toUpperCase() : 'WORKING',
      activity: activity || null,
    };
  };

  // 'off' — no turn in flight in the viewed chat — keeps the pre-signal
  // behaviour: an indicator with no live turn behind it (an IDE surface, a
  // worker bubble) is not this signal's to judge.
  function signalState() {
    return window.streamActivitySignal().state;
  }

  // A random phrase (no trailing ellipsis).
  window.thinkingPhrase = function () { return pick(); };

  // Which indicators this signal is entitled to speak for. It is derived for
  // exactly ONE turn — the one in the chat on screen — and the only indicator
  // rendering that turn sits inside its live bubble, stamped data-live="1" by
  // whichever path built it (chat-render-artifacts.js _buildLiveAssistantInto,
  // chat-send.js) and un-stamped by finalizeLiveMessageInPlace on the terminal
  // paint. Every other .thinking on the page has its own life: a voice reply
  // bubble driven by the voice WS (chat-voice-ws-handler.js renders this same
  // markup through addMessageEl, which never stamps data-live), a worker
  // bubble, an IDE surface. Freezing one of those to 'Radio silence' because
  // the main chat wedged is the identical lie this file exists to remove, just
  // pointed the other way — so they keep the plain rotation.
  function ownsIndicator(el) {
    return !!(el.closest && el.closest('[data-live="1"]'));
  }

  // The chat thinking-indicator markup: a themed phrase followed by the three
  // blinking dots that read as its ellipsis — stilled, with the silence line
  // instead of a phrase, when nothing is arriving. The state is baked in at
  // BUILD time and not just applied by the tick below because the live bubble
  // is destroyed and rebuilt on every WS event: a rebuild during a silent
  // stretch would otherwise flash a working indicator for a full tick.
  window.thinkingHTML = function () {
    var state = signalState();
    var dot = state === 'silent' ? '<span style="animation:none">.</span>' : '<span>.</span>';
    // This function returns a STRING, so at build time it cannot know which
    // surface its markup is about to be attached to — only the silence is
    // worth correcting, and the caller's innerHTML/appendChild has run by the
    // next microtask, which still resolves before the browser's next paint.
    // So a foreign bubble born wearing this chat's silence is handed back to
    // the plain rotation without the wrong label ever reaching the screen.
    if (state === 'silent') queueMicrotask(unclaimForeignIndicators);
    return '<div class="thinking" data-signal="' + state + '"><span class="thinking-phrase">' +
      (state === 'silent' ? SILENT_PHRASE : pick()) + '</span>' + dot + dot + dot + '</div>';
  };

  // Release any indicator that was baked silent but turned out not to be this
  // signal's to judge. Cheap by construction: it only runs while the viewed
  // turn is silent, which is precisely when no events are arriving.
  function unclaimForeignIndicators() {
    var els = document.querySelectorAll('.thinking[data-signal="silent"]');
    for (var i = 0; i < els.length; i++) {
      if (!ownsIndicator(els[i])) applySignal(els[i], 'off');
    }
  }

  // Apply the current signal to one indicator: rotate the phrase and leave the
  // dots blinking while there is real work behind them, freeze both when there
  // is not. Inline animation only — no stylesheet owns a "silent" rule, and
  // the blink comes from `.thinking span`, so clearing the inline value hands
  // the dots straight back to app.css.
  function applySignal(el, state) {
    var silent = state === 'silent';
    var dots = el.querySelectorAll('span:not(.thinking-phrase)');
    for (var i = 0; i < dots.length; i++) dots[i].style.animation = silent ? 'none' : '';
    el.dataset.signal = state;
    var phrase = el.querySelector('.thinking-phrase');
    if (!phrase) return;
    phrase.textContent = silent ? SILENT_PHRASE : pick(phrase.textContent);
  }

  // Rotate every live indicator so a long turn cycles through phrases instead of
  // freezing on one. One shared timer; removed indicators just stop matching, so
  // there's nothing to clean up. The tick also RE-STATES the signal, because an
  // indicator can outlive the state it was built in: a turn that goes silent
  // with no content yet produces no repaint at all (the live-bubble idle ticker
  // in chat-render-live.js skips content-empty turns), so this is the only
  // thing that will ever still it. Indicators this signal doesn't own are
  // re-stated as 'off' — rotating, dots blinking — which is exactly the
  // pre-signal behaviour, not a claim about them.
  setInterval(function () {
    var state = signalState();
    var els = document.querySelectorAll('.thinking');
    for (var i = 0; i < els.length; i++) {
      applySignal(els[i], ownsIndicator(els[i]) ? state : 'off');
    }
  }, 3800);
})();
