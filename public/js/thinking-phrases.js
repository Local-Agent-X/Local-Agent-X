// Themed "thinking" status phrases for Agent X — covert-operative flavor, the
// single source for the chat thinking indicator and the IDE status label.
// Phrases are stored WITHOUT a trailing ellipsis; the blinking dots in the
// indicator (or the appended "…" in the IDE label) supply it.
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

  function pick(exclude) {
    var p = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    if (exclude && p === exclude && PHRASES.length > 1) return pick(exclude);
    return p;
  }

  // A random phrase (no trailing ellipsis).
  window.thinkingPhrase = function () { return pick(); };

  // The chat thinking-indicator markup: a themed phrase followed by the three
  // blinking dots that read as its ellipsis.
  window.thinkingHTML = function () {
    return '<div class="thinking"><span class="thinking-phrase">' + pick() +
      '</span><span>.</span><span>.</span><span>.</span></div>';
  };

  // Rotate every live indicator so a long turn cycles through phrases instead of
  // freezing on one. One shared timer; removed indicators just stop matching, so
  // there's nothing to clean up.
  setInterval(function () {
    var els = document.querySelectorAll('.thinking .thinking-phrase');
    for (var i = 0; i < els.length; i++) els[i].textContent = pick(els[i].textContent);
  }, 3800);
})();
