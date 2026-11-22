// ── Agents panel: this chat's work, or everyone's ──
//
// The AGENTS tab shows the chat on screen: the agents and jobs that chat
// started. A "This chat / All" switch widens it to every chat's work, each
// job under its chat's name. Work that belongs to no chat (a dream, a
// scheduled mission, autopilot) shows in every chat.
//
// Which chat a card belongs to is the chat its frame was sent for, taken from
// the top of its spawn lineage: a build's worker belongs to the chat that
// started the build, whatever session the worker itself runs in.
//
// A chat that is not on screen never opens or turns the panel; its sidebar row
// is marked active instead (the same mark a background reply gets).
//
// Loads BEFORE chat-agent-feeds.js. External deps at call time: activeChat,
// chats (app-state.js), agentFeedsData, _renderAgentFeedsList,
// renderWorkClaims, ChatStreamStore, renderSidebar.

var AGENT_FEEDS_SCOPE_KEY = 'lax_agent_feeds_scope';
var agentFeedsScope = (function () {
  try { return localStorage.getItem(AGENT_FEEDS_SCOPE_KEY) === 'all' ? 'all' : 'chat'; } catch (e) { return 'chat'; }
})();

function agentFeedsChatId() {
  try { return (typeof activeChat !== 'undefined' && activeChat && activeChat.id) || ''; } catch (e) { return ''; }
}

// Pure: the chat a record belongs to, '' when none is on record. The topmost
// ancestor that names one wins; a cycle in the lineage stops the walk.
function feedChatOf(rec, map) {
  var found = '', seen = {}, cur = rec;
  while (cur && cur.id && !seen[cur.id]) {
    seen[cur.id] = 1;
    if (cur.chatId) found = cur.chatId;
    cur = cur.parentOpId ? (map || {})[cur.parentOpId] : null;
  }
  return found;
}

// Pure: the records a chat's panel lists. `isChat(id)` says whether a session
// id is a chat this window knows; work whose session is not one (or that names
// none) belongs to no chat and is listed everywhere.
function feedsOfChat(map, chatId, isChat) {
  var out = {}, ids = Object.keys(map || {});
  for (var i = 0; i < ids.length; i++) {
    var owner = feedChatOf(map[ids[i]], map);
    if (owner === chatId || !owner || !isChat(owner)) out[ids[i]] = map[ids[i]];
  }
  return out;
}

function agentFeedIsChat(id) {
  try { return typeof chats !== 'undefined' && chats.some(function (c) { return c.id === id; }); } catch (e) { return false; }
}

function agentFeedChatTitle(id) {
  try {
    var c = typeof chats !== 'undefined' && chats.find(function (x) { return x.id === id; });
    return c ? (c.title || 'Untitled chat') : '';
  } catch (e) { return ''; }
}

// What the list draws now: the chat on screen's work, or everything.
function visibleAgentFeeds() {
  var chatId = agentFeedsChatId();
  if (agentFeedsScope === 'all' || !chatId) return agentFeedsData;
  return feedsOfChat(agentFeedsData, chatId, agentFeedIsChat);
}

// Whether a record may open or turn the panel: its chat is on screen, or it
// belongs to no chat (as before this file).
function feedIsOnScreen(rec) {
  var owner = feedChatOf(rec, agentFeedsData);
  return !owner || owner === agentFeedsChatId() || !agentFeedIsChat(owner);
}

// A chat not on screen had an agent start: mark its sidebar row.
function markFeedChatActive(rec) {
  var owner = feedChatOf(rec, agentFeedsData);
  if (!owner || typeof ChatStreamStore === 'undefined' || !ChatStreamStore.setSidebarActive) return;
  ChatStreamStore.setSidebarActive(owner, true);
  if (typeof renderSidebar === 'function') renderSidebar();
}

// In All, each job carries its chat's name; '' in This chat (it is the one on screen).
function agentFeedChatLabel(id) {
  if (agentFeedsScope !== 'all') return '';
  return agentFeedChatTitle(feedChatOf(agentFeedsData[id], agentFeedsData));
}

// Pure: the "This chat / All" switch, as the Agents and Artifacts tabs draw it.
// `setter` is the global each button calls with 'chat' or 'all'.
function panelScopeHtml(scope, setter, chatTitle, allTitle) {
  function btn(key, label, title) {
    return '<button type="button" class="artifact-filter' + (scope === key ? ' active' : '') + '" aria-pressed="' + (scope === key ? 'true' : 'false') + '"'
      + ' title="' + title + '" onclick="' + setter + '(\'' + key + '\')">' + label + '</button>';
  }
  return btn('chat', 'This chat', chatTitle) + btn('all', 'All chats', allTitle);
}

function renderAgentFeedsScope() {
  var host = document.getElementById('agent-feeds-scope');
  if (host) host.innerHTML = panelScopeHtml(agentFeedsScope, 'setAgentFeedsScope', 'Agents and jobs this chat started', 'Every chat’s agents and jobs');
}

function redrawAgentFeedsForScope() {
  if (typeof _renderAgentFeedsList === 'function') _renderAgentFeedsList();
  if (typeof renderWorkClaims === 'function') renderWorkClaims();
}

function setAgentFeedsScope(scope) {
  agentFeedsScope = scope === 'all' ? 'all' : 'chat';
  try { localStorage.setItem(AGENT_FEEDS_SCOPE_KEY, agentFeedsScope); } catch (e) { /* private mode: the choice lasts the page */ }
  renderAgentFeedsScope();
  redrawAgentFeedsForScope();
}

// Another chat came on screen: the list is that chat's now, and the strip
// asks the server for that chat's rows.
window.laxAgentFeedsScope = {
  onChatChanged: function () {
    if (typeof _renderAgentFeedsList === 'function') _renderAgentFeedsList();
    if (typeof refreshWorkClaims === 'function') refreshWorkClaims();
  },
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderAgentFeedsScope);
  else renderAgentFeedsScope();
}
