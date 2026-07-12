// Home launcher — picks the empty-state layout and wires starter cards.
//
// Two layouts live inside #empty (see app.html): the classic hero and the
// command-center launcher. Which one shows is gated by the lax_home_style
// localStorage flag ('command' | 'classic'); default is 'classic' so the flag
// is a pure, revertable toggle — no behavior change until a user opts in.
//
// Starter cards do REAL things: data-prompt prefills the composer and focuses
// it (the user sees what will send and can edit before hitting enter);
// data-nav routes to a page. No card is decorative.
(function () {
  function homeStyle() {
    try { return localStorage.getItem('lax_home_style') || 'classic'; } catch { return 'classic'; }
  }

  // Single source of truth for the #empty markup. Both the static app.html copy
  // and chat-render.js's re-render call this, so the two layouts can't diverge.
  // `subtitle` lets the caller vary the classic-hero line by context.
  function emptyHTML(subtitle) {
    var sub = subtitle || 'Select a chat or start a new one.';
    return ''
      + '<div id="empty">'
      +   '<div class="home-hero" data-home="classic">'
      +     '<h2>LOCAL AGENT X</h2><p>' + sub + '</p>'
      +   '</div>'
      +   '<div class="home-launcher" data-home="command" hidden>'
      +     '<h2 class="hl-title">What\'s next?</h2>'
      +     '<div class="hl-starters" role="list">'
      +       card('research', 'data-prompt="Research: "', '&#9673;', 'Research', 'Deep-dive a question, cited')
      +       card('build', 'data-prompt="Build me an app that "', '&#9650;', 'Build', 'Ship an app from an idea')
      +       card('automate', 'data-nav="missions"', '&#8635;', 'Automate', 'Schedule a recurring job')
      +       card('apps', 'data-nav="apps"', '&#9638;', 'Open app', 'Pick up where you left off')
      +     '</div>'
      +   '</div>'
      + '</div>';
  }
  function card(key, attr, icon, title, sub) {
    return '<button class="hl-card" role="listitem" data-starter="' + key + '" ' + attr + '>'
      + '<span class="hl-ci" aria-hidden="true">' + icon + '</span>'
      + '<span class="hl-ct">' + title + '</span>'
      + '<span class="hl-cs">' + sub + '</span></button>';
  }
  // Render the empty state into a container and immediately apply the flag.
  window.renderEmptyInto = function (el, subtitle) {
    el.innerHTML = emptyHTML(subtitle);
    applyHomeStyle();
  };

  // Toggle the two layouts whenever an #empty is present. Called on load and
  // re-run if the empty state is re-rendered (new chat). Idempotent.
  function applyHomeStyle() {
    var empty = document.getElementById('empty');
    if (!empty) return;
    var command = homeStyle() === 'command';
    var hero = empty.querySelector('[data-home="classic"]');
    var launcher = empty.querySelector('[data-home="command"]');
    if (hero) hero.hidden = command;
    if (launcher) launcher.hidden = !command;
  }

  // Event delegation on document so it keeps working after #empty is removed
  // (first send) and re-added (returning to a fresh chat).
  document.addEventListener('click', function (e) {
    var card = e.target.closest('.hl-card');
    if (!card) return;
    var nav = card.getAttribute('data-nav');
    if (nav && typeof navigate === 'function') { navigate(nav); return; }
    var prompt = card.getAttribute('data-prompt');
    if (prompt != null) {
      var input = document.getElementById('msg-input');
      if (input) {
        input.value = prompt;
        input.focus();
        // Put the caret at the end so the user types straight into the prompt.
        try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
        // Nudge any autosize listeners that key off input events.
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyHomeStyle, { once: true });
  } else {
    applyHomeStyle();
  }
  // Re-apply when a fresh empty state mounts (newChat clears #messages).
  window.applyHomeStyle = applyHomeStyle;
})();
