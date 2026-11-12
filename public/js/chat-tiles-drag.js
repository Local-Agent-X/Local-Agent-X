// ── Chat tiles: moving a pane by dragging it ──
//
// A pane of the tile grid (chat-tiles.js) is picked up by its head and dropped
// on another pane, which it then takes the place of. The head of a live view
// (.chat-tile-head, chat-tiles-view.js) and the head of the chat on screen
// (#chat-tile-head) are the only draggable parts, so text in a pane still
// selects and the message box still takes a drop of its own.
//
// This file only says which pane was dropped on which; chat-tiles.js reorders
// (ChatTilesCore.moved) and lays the grid out again.

var ChatTilesDrag = (function () {
  var dragging = '';

  function elementOf(target) {
    return target && target.nodeType === 1 ? target : target && target.parentElement;
  }

  /** The chat whose pane `target` is in: a live view's, or the chat on screen's. */
  function paneOf(target, focusedId) {
    var el = elementOf(target);
    if (!el || !el.closest) return '';
    var tile = el.closest('.chat-tile');
    if (tile) return tile.dataset.session || '';
    return el.closest('#chat-main') ? focusedId() : '';
  }

  function end() {
    dragging = '';
    document.body.classList.remove('chat-tiles-dragging');
  }

  /** `onMove(fromId, toId)` is called when one pane is dropped on another. */
  function wire(grid, focusedId, onMove) {
    grid.addEventListener('dragstart', function (e) {
      var el = elementOf(e.target);
      var head = el && el.closest ? el.closest('.chat-tile-head') : null;
      dragging = head ? paneOf(head, focusedId) : '';
      if (!dragging) return;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragging); } catch (err) { /* the drag still works without a payload */ }
      }
      document.body.classList.add('chat-tiles-dragging');
    });
    grid.addEventListener('dragover', function (e) {
      if (!dragging) return;
      var over = paneOf(e.target, focusedId);
      if (!over || over === dragging) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    grid.addEventListener('drop', function (e) {
      if (!dragging) return;
      var from = dragging;
      var over = paneOf(e.target, focusedId);
      end();
      if (!over || over === from) return;
      e.preventDefault();
      onMove(from, over);
    });
    grid.addEventListener('dragend', end);
  }

  return { wire: wire };
})();
