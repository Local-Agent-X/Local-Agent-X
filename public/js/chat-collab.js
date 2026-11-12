// ── Chat: collab, several models on one question ──
//
// A collab (ADR 0007 §9, src/agency/collab.ts) is started from an ordinary
// chat: the Collab button in the chat toolbar, or `/collab <the question>` in
// the message box. A card shows what will run (the models, the steps, the depth, how
// many turns that is) and nothing starts until Start. The server then makes
// one chat per model and runs the steps; this chat writes the result.
//
// Here: the card, the strip that says where the collab is (step, Stop), and
// the list of collabs. The tile grid reads it to put a collab's chats side by
// side (chat-tiles.js), opened by itself the first time a chat of a running
// collab is on screen; the sidebar reads it to list each model's chat under
// the chat the collab was started from (app-sidebar-render.js). Re-read on a
// `collab_changed` frame.
//
// External deps: apiFetch (shared-api.js); chats, saveChats, renderSidebar
// (app-state.js, app-sidebar-render.js); chatModeOf (sidebar-mode.js);
// syncChatsFromServer, hydrateChat (app-sync.js); laxChatTiles (chat-tiles.js).

var laxCollab = (function () {
  var MAX_MEMBERS = 4;
  var collabs = [];
  var paintedFor = '';
  // The collabs already read (null before the first read), and the ones the
  // tile grid was opened for.
  var known = null;
  var tiled = {};

  function active() { try { return window.activeChat || null; } catch (e) { return null; } }
  function chatList() { return typeof chats !== 'undefined' && Array.isArray(chats) ? chats : []; }
  function isLive(c) { return c.state === 'running'; }

  /** The newest collab the chat is part of ({id, chatIds, ...}), or null. */
  function of(chatId) {
    for (var i = collabs.length - 1; i >= 0; i--) if (collabs[i].chatIds.indexOf(chatId) !== -1) return collabs[i];
    return null;
  }

  /** One line saying where a collab is. */
  function statusText(c) {
    var n = c.members.filter(function (m) { return !m.dropped; }).length;
    var models = n + (n === 1 ? ' model' : ' models');
    if (c.state === 'done') return 'Collab finished' + (c.note ? ': ' + c.note : '');
    if (c.state !== 'running') return 'Collab stopped' + (c.note ? ': ' + c.note : '');
    if (c.phase === 'challenge') return 'Collab: ' + models + ' checking each other’s claims';
    if (c.phase === 'answer') return 'Collab: answering ' + c.disputed + (c.disputed === 1 ? ' challenge' : ' challenges');
    if (c.phase === 'dispute') return 'Collab: settling ' + c.disputed + (c.disputed === 1 ? ' dispute' : ' disputes') + ', round ' + c.disputeRound + ' of 2';
    if (c.phase === 'writing') return 'Collab: writing the result';
    return 'Collab: ' + models + ' researching';
  }

  /** The turns a collab of this size runs, in words. `steps`: 1 research,
   *  2 and challenge, 3 and answer. */
  function costText(members, steps, depth) {
    var parts = [members + ' research turns' + (depth === 'deep' ? ' (deep: each takes longer)' : '')];
    if (steps >= 2) parts.push(members + ' turns checking each other’s claims');
    if (steps >= 3) parts.push('up to ' + (members * 3) + ' short turns answering challenges and settling what is still disputed');
    parts.push('one turn in this chat to write the result');
    return parts.join(', then ') + '. Each turn is billed to that model’s account.';
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
  function adopt(c) {
    var added = false;
    c.members.forEach(function (m) {
      if (chatList().some(function (x) { return x.id === m.sessionId; })) return;
      var now = Date.now();
      chatList().unshift({ id: m.sessionId, title: m.label, messages: [], createdAt: now, updatedAt: now, startedFrom: c.hostId, _needsHydrate: true });
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
      var fresh = known ? collabs.filter(function (c) { return !known[c.id]; }) : [];
      known = {};
      collabs.forEach(function (c) { known[c.id] = true; });
      collabs.filter(isLive).forEach(adopt);
      fresh.forEach(rereadHost);
      paint();
      showTiles();
      try { if (window.laxChatTiles) window.laxChatTiles.onChatChanged(); } catch (e) {}
    }).catch(function () { /* the next frame asks again */ });
  }

  /** A collab just started: the app saved the question into the chat it was
   *  started from, so that chat is read again. */
  function rereadHost(c) {
    var host = chatList().filter(function (x) { return x.id === c.hostId; })[0];
    if (!host || typeof hydrateChat !== 'function') return;
    host._needsHydrate = true;
    var a = active();
    if (a && a.id === host.id) Promise.resolve(hydrateChat(host, { force: true })).catch(function () {});
  }

  /** A chat of a running collab is on screen: show all of its chats side by
   *  side. Once per collab, so turning the grid off afterwards stays off. */
  function showTiles() {
    var a = active();
    var c = a ? of(a.id) : null;
    if (!c || !isLive(c) || tiled[c.id]) return;
    tiled[c.id] = true;
    try { if (window.laxChatTiles) window.laxChatTiles.showGroup(); } catch (e) {}
  }

  /** `list` with each model's chat taken out and kept under the chat its
   *  collab was started from, when that chat is in the list too. */
  function nest(list) {
    var listed = {};
    list.forEach(function (c) { listed[c.id] = true; });
    var top = [];
    var under = {};
    list.forEach(function (c) {
      var k = of(c.id);
      if (k && k.hostId !== c.id && listed[k.hostId]) (under[k.hostId] = under[k.hostId] || []).push(c);
      else top.push(c);
    });
    Object.keys(under).forEach(function (hostId) {
      var order = of(hostId).chatIds;
      under[hostId].sort(function (x, y) { return order.indexOf(x.id) - order.indexOf(y.id); });
    });
    return { top: top, under: under };
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

  /** A labelled choice on the card; `options` are [value, text], the first chosen. */
  function choice(box, label, options) {
    var row = el('label', 'collab-choice', label);
    var pick = el('select');
    options.forEach(function (o) { var opt = el('option', '', o[1]); opt.value = o[0]; pick.appendChild(opt); });
    pick.value = options[0][0];
    row.appendChild(pick);
    box.appendChild(row);
    return pick;
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
    box.appendChild(el('div', 'collab-card-note', 'Each model researches the same question in its own chat. They then check each other’s claims and answer the challenges. This chat does no research: it compiles their reports and says what was confirmed, what was conceded and what is still disputed.'));
    var q = el('textarea', 'collab-question');
    q.value = question; q.rows = 3; q.maxLength = 4000; q.placeholder = 'What should they research?';
    box.appendChild(q);
    var picks = defaultPicks(data.providers, data.current);
    (data.providers || []).forEach(function (p) { box.appendChild(memberRow(p, picks.indexOf(p.id) !== -1, data.current)); });
    var steps = choice(box, 'Steps ', [['3', 'Research, challenge and answer'], ['2', 'Research and challenge'], ['1', 'Research only']]);
    var depth = choice(box, 'Depth ', [['standard', 'Standard'], ['deep', 'Deep: plan, search wide, try to refute, full report']]);
    var cost = el('div', 'collab-card-note');
    var error = el('div', 'collab-card-error');
    var start = el('button', 'own-copy-btn', 'Start');
    start.type = 'button';
    var cancel = el('button', 'own-copy-btn quiet', 'Cancel');
    cancel.type = 'button';
    function update() {
      var n = picked(card).length;
      cost.textContent = n < 2 ? 'Pick at least two models.' : n > MAX_MEMBERS ? 'Pick at most ' + MAX_MEMBERS + ' models.' : costText(n, Number(steps.value), depth.value);
      start.disabled = n < 2 || n > MAX_MEMBERS || !q.value.trim();
    }
    box.addEventListener('change', update);
    q.addEventListener('input', update);
    cancel.addEventListener('click', closeCard);
    start.addEventListener('click', function () {
      start.disabled = true;
      error.textContent = '';
      begin(q.value.trim(), picked(card), Number(steps.value), depth.value).then(function (problem) {
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
  function begin(question, members, steps, depth) {
    var a = active();
    if (!a) return Promise.resolve('Open a chat first.');
    return apiFetch('/api/collab/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: a.id, question: question, members: members, steps: steps, depth: depth }),
    }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); }).then(function (out) {
      if (!out.ok || !out.data.collab) return out.data.error || 'The collab could not start.';
      collabs = collabs.filter(function (c) { return c.id !== out.data.collab.id; }).concat([out.data.collab]);
      known = known || {};
      known[out.data.collab.id] = true;
      adopt(out.data.collab);
      rereadHost(out.data.collab);
      paint();
      showTiles();
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
    setInterval(function () { var a = active(); if ((a ? a.id : '') !== paintedFor) { paint(); showTiles(); } }, 1000);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  return { of: of, nest: nest, open: function () { open(''); }, takeCommand: takeCommand, refresh: refresh, statusText: statusText, costText: costText, defaultPicks: defaultPicks };
})();
