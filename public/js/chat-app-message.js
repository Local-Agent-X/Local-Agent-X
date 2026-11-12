// ── Chat: a message the app sent, drawn small ──
//
// A collab (src/agency/collab-messages.ts) runs each step by sending a chat a
// message: the brief for a step, or, to the chat the collab started from, every
// model's report and the app's record of their claims. Those are saved as the
// chat's "user" rows, because that is how a turn starts, but the user did not
// type them and some are tens of thousands of characters long.
//
// Such a row is drawn as one line saying what it is ("Collab finished: the
// models' reports and the app's record of their claims"), labelled App, with
// the whole text one click away. Nothing is hidden: the text is all there.
//
// summaryOf is plain text in, text out, so the tile grid's live views use it
// too (chat-tiles.js). The phone has the same rule (agentxos-mobile
// app/src/chat/appMessageText.ts).

var laxAppMessage = (function () {
  /** What an app-sent message is, in a line; null for anything the user typed. */
  function summaryOf(text) {
    if (typeof text !== 'string' || text.charAt(0) !== '(') return null;
    var first = text.split('\n')[0];
    if (first.indexOf('not typed by the user') === -1) return null;
    if (first.indexOf('(Collab finished') === 0) return 'Collab finished: the models’ reports and the app’s record of their claims';
    var step = /^\(Collab, ([^.]+)\./.exec(first);
    if (step) return 'Collab: the brief for ' + step[1];
    return first.indexOf('(From the app') === 0 ? 'A note from the app' : null;
  }

  /** Turn the user row `node` (from addMessageEl) into the small app row. */
  function apply(node, text, summary) {
    var body = node && node.querySelector ? node.querySelector('.msg-body') : null;
    if (!body) return node;
    node.classList.add('app-message');
    node.setAttribute('aria-label', 'Message sent by the app');
    var label = node.querySelector('.msg-label');
    if (label) label.textContent = 'App';
    var details = document.createElement('details');
    var line = document.createElement('summary');
    line.textContent = summary;
    var whole = document.createElement('div');
    whole.className = 'app-message-text';
    whole.textContent = text;
    details.appendChild(line);
    details.appendChild(whole);
    body.textContent = '';
    body.appendChild(details);
    return node;
  }

  return { summaryOf: summaryOf, apply: apply };
})();
