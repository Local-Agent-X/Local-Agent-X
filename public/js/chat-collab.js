// ── Chat: collab, several models on one question ──
//
// A collab (ADR 0007 §9, src/agency/collab.ts) is started from an ordinary
// chat: the Collab button in the chat toolbar, or `/collab <the question>` in
// the message box. A card shows what will run (the models, the rounds, how
// many turns that is) and nothing starts until Start. The server then makes
// one chat per model and runs the rounds; this chat writes the result.
//
// Here: the card, the strip that says where the collab is (round, Stop), and
// the list of collabs the tile grid reads to put a collab's chats side by
// side (chat-tiles.js). Re-read on a `collab_changed` frame.
//
// External deps: apiFetch (shared-api.js); chats, saveChats, renderSidebar
// (app-state.js, app-sidebar-render.js); chatModeOf (sidebar-mode.js);
// syncChatsFromServer (app-sync.js); laxChatTiles (chat-tiles.js).

var laxCollab = (function () {
  var MAX_MEMBERS = 4;
  var collabs = [];
  var paintedFor = '';

  function active() { try { return window.activeChat || null; } catch (e) { return null; } }
  function chatList() { return typeof chats !== 'undefined' && Array.isArray(chats) ? chats : []; }
  function isLive(c) { return c.state === 'running' || c.state === 'writing'; }

  /** The newest collab the chat is part of ({id, chatIds, ...}), or null. */
  function of(chatId) {
    for (var i = collabs.length - 1; i >= 0; i--) if (collabs[i].chatIds.indexOf(chatId) !== -1) return collabs[i];
    return null;
  }

  /** One line saying where a collab is. */
  function statusText(c) {
    var n = c.members.filter(function (m) { return !m.dropped; }).length;
    if (c.state === 'running') return 'Collab: round ' + Math.max(1, c.round) + ' of ' + c.rounds + ', ' + n + (n === 1 ? ' model' : ' models');
    if (c.state === 'writing') return 'Collab: writing the result';
    if (c.state === 'done') return 'Collab finished';
    return 'Collab stopped' + (c.note ? ': ' + c.note : '');
  }

  /** How many turns a collab of this size runs, in words. */
  function costText(members, rounds) {
    return members + ' models x ' + rounds + (rounds === 1 ? ' round' : ' rounds') + ' = ' + (members * rounds)
      + ' research turns, then one turn in this chat to write the result. Each turn is billed to that model’s account.';
  }

  /** The members a new card starts with: this chat's model, then one from each other provider. */
  function defaultPicks(providers, current) {
    var list = (providers || []).filter(function (p) { return p && p.id; });
    var first = list.filter(function (p) { return current && p.id === current.provider; });
    var rest = list.filter(function (p) { return !current || p.id !== current.provider; });
    return first.concat(rest).slice(0, 3).map(function (p) { return p.id; });
  }

  // ── The collabs on record ──

  /** A member chat the server made is not in this page's list until it is added. */
  function adopt(c, titles) {
    var added = false;
    c.members.forEach(function (m) {
      if (chatList().some(function (x) { return x.id === m.sessionId; })) return;
      var now = Date.now();
      chatList().unshift({ id: m.sessionId, title: (titles && titles[m.sessionId]) || m.label, messages: [], createdAt: now, updatedAt: now, startedFrom: c.hostId, _needsHydrate: true });
      added = true;
    });
    if (!added) return;
    try { saveChats(); renderSidebar(); } catch (e) { /* the next sync lists them */ }
  }

  function refresh() {
    if (typeof apiFetch !== 'function') return Promise.resolve();
    return apiFetch('/api/collab').then(function (res) { return res && res.ok ? res.json() : null; }).then(function (data) {
      if (!data || !Array.isArray(data.collabs)) return;
      collabs = data.collabs;
      collabs.filter(isLive).forEach(function (c) { adopt(c); });
      paint();
      try { if (window.laxChatTiles) window.laxChatTiles.onChatChanged(); } catch (e) {}
    }).catch(function () { /* the next frame asks again */ });
  }

  // ── The strip and the button ──

  function paint() {
    var a = active();
    paintedFor = a ? a.id : '';
    var btn = document.getElementById('chat-collab-btn');
    var strip = document.getElementById('collab-strip');
    var c = a ? of(a.id) : null;
    var ordinary = !!a && chatModeOf(a) !== 'code';
    // A member's chat belongs to its collab; a chat hosting a live one waits for it.
    if (btn) btn.style.display = ordinary && (!c || (c.hostId === a.id && !isLive(c))) ? '' : 'none';
    if (!strip) return;
    strip.textContent = '';
    strip.style.display = c ? '' : 'none';
    if (!c) return;
    var text = document.createElement('span');
    text.textContent = statusText(c);
    text.title = c.question;
    strip.appendChild(text);
    if (!isLive(c)) return;
    var stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'own-copy-btn quiet';
    stop.textContent = 'Stop';
    stop.addEventListener('click', function () {
      apiFetch('/api/collab/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id }) }).then(refresh);
    });
    strip.appendChild(stop);
  }

  // ── The card ──

  function closeCard() {
    var el = document.getElementById('collab-card');
    if (el) el.remove();
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function memberRow(p, checked, current) {
    var row = el('label', 'collab-member');
    var box = el('input');
    box.type = 'checkbox'; box.checked = checked; box.dataset.provider = p.id;
    var pick = el('select', 'collab-model');
    (p.models && p.models.length ? p.models : ['']).forEach(function (m) {
      var o = el('option', '', m || 'Default model');
      o.value = m;
      pick.appendChild(o);
    });
    if (current && current.provider === p.id && current.model) pick.value = current.model;
    row.appendChild(box); row.appendChild(el('span', 'collab-provider', p.name || p.id)); row.appendChild(pick);
    return row;
  }

  function picked(card) {
    return Array.prototype.slice.call(card.querySelectorAll('.collab-member')).filter(function (row) {
      return row.querySelector('input').checked;
    }).map(function (row) {
      return { provider: row.querySelector('input').dataset.provider, model: row.querySelector('select').value };
    });
  }

  function buildCard(question, data) {
    var card = el('div', 'collab-card');
    card.id = 'collab-card';
    var box = el('div', 'collab-card-box');
    box.appendChild(el('div', 'collab-card-title', 'Collab: several models on one question'));
    box.appendChild(el('div', 'collab-card-note', 'Each model researches the question in its own chat, reads the others’ answers and revises. This chat then writes the result: what they agreed on, where they differ, and the sources.'));
    var q = el('textarea', 'collab-question');
    q.value = question; q.rows = 3; q.maxLength = 4000; q.placeholder = 'What should they research?';
    box.appendChild(q);
    var picks = defaultPicks(data.providers, data.current);
    (data.providers || []).forEach(function (p) { box.appendChild(memberRow(p, picks.indexOf(p.id) !== -1, data.current)); });
    var roundsRow = el('label', 'collab-rounds', 'Rounds ');
    var rounds = el('select');
    [1, 2, 3].forEach(function (n) { var o = el('option', '', String(n)); o.value = String(n); rounds.appendChild(o); });
    rounds.value = '2';
    roundsRow.appendChild(rounds);
    box.appendChild(roundsRow);
    var cost = el('div', 'collab-card-note');
    var error = el('div', 'collab-card-error');
    var start = el('button', 'own-copy-btn', 'Start');
    start.type = 'button';
    var cancel = el('button', 'own-copy-btn quiet', 'Cancel');
    cancel.type = 'button';
    function update() {
      var n = picked(card).length;
      cost.textContent = n < 2 ? 'Pick at least two models.' : n > MAX_MEMBERS ? 'Pick at most ' + MAX_MEMBERS + ' models.' : costText(n, Number(rounds.value));
      start.disabled = n < 2 || n > MAX_MEMBERS || !q.value.trim();
    }
    box.addEventListener('change', update);
    q.addEventListener('input', update);
    cancel.addEventListener('click', closeCard);
    start.addEventListener('click', function () {
      start.disabled = true;
      error.textContent = '';
      begin(q.value.trim(), picked(card), Number(rounds.value)).then(function (problem) {
        if (!problem) { closeCard(); return; }
        error.textContent = problem;
        update();
      });
    });
    var actions = el('div', 'collab-card-actions');
    actions.appendChild(cancel); actions.appendChild(start);
    box.appendChild(cost); box.appendChild(error); box.appendChild(actions);
    card.appendChild(box);
    card.addEventListener('click', function (e) { if (e.target === card) closeCard(); });
    update();
    return card;
  }

  /** Open the card for the chat on screen, with `question` filled in. */
  function open(question) {
    var a = active();
    if (!a || chatModeOf(a) === 'code' || typeof apiFetch !== 'function') return;
    closeCard();
    apiFetch('/api/providers?session=' + encodeURIComponent(a.id)).then(function (res) { return res && res.ok ? res.json() : null; }).then(function (data) {
      if (!data) return;
      document.body.appendChild(buildCard(question || '', data));
      var q = document.querySelector('#collab-card .collab-question');
      if (q) q.focus();
    }).catch(function () { /* nothing opens; the button is still there */ });
  }

  /** Start it. Resolves to '' when it started, else what went wrong. */
  function begin(question, members, rounds) {
    var a = active();
    if (!a) return Promise.resolve('Open a chat first.');
    return apiFetch('/api/collab/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: a.id, question: question, members: members, rounds: rounds }),
    }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); }).then(function (out) {
      if (!out.ok || !out.data.collab) return out.data.error || 'The collab could not start.';
      collabs = collabs.filter(function (c) { return c.id !== out.data.collab.id; }).concat([out.data.collab]);
      adopt(out.data.collab, out.data.titles);
      paint();
      try { if (window.laxChatTiles) window.laxChatTiles.showGroup(); } catch (e) {}
      try { if (typeof syncChatsFromServer === 'function') syncChatsFromServer(); } catch (e) {}
      return '';
    }).catch(function () { return 'Could not reach the server.'; });
  }

  /** `/collab <question>` in the message box opens the card instead of sending. */
  function takeCommand() {
    var input = document.getElementById('msg-input');
    var m = input ? /^\/collab(?:\s+([\s\S]*))?$/.exec(input.value.trim()) : null;
    var a = active();
    if (!m || !a || chatModeOf(a) === 'code') return false;
    input.value = '';
    open((m[1] || '').trim());
    return true;
  }

  function init() {
    refresh();
    // Another chat was opened: its strip is a different collab's, or none.
    setInterval(function () { var a = active(); if ((a ? a.id : '') !== paintedFor) paint(); }, 1000);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  return { of: of, open: function () { open(''); }, takeCommand: takeCommand, refresh: refresh, statusText: statusText, costText: costText, defaultPicks: defaultPicks };
})();
