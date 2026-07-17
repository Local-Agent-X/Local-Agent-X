// ── ChatStreamStore: block timeline helpers ──
//
// The ordered per-turn timeline the renderer walks: reasoning, text, and
// mid-turn inject blocks in ARRIVAL order. Replaces the flat two-lane
// render shape whose fixed visual order pinned one giant "Thinking" box to
// the top of the bubble no matter when each thought actually streamed.
//
// The lanes themselves (entry.content / entry.reasoning) still exist:
// persistence, TTS, the error-dedup guard, and the live-render throttle all
// read them. Blocks are the RENDER timeline only — built by the same
// reducer from the same events, so the two representations cannot drift.
//
// Block shapes (entry.blocks[]):
//   { id, type: 'text',      text }
//   { id, type: 'reasoning', text }
//   { id, type: 'inject',    injectId, text, ts, queueState: 'queued'|'consumed' }
//
// Split rules: a delta merges into the tail block when the lane matches and
// no boundary is pending. Tool events (and replayed deltas stamped
// boundary:true by the server) mark a boundary so the next delta of either
// lane opens a fresh block — that boundary is what lets a second thinking
// phase render BELOW the text it followed instead of being retconned into
// the block at the top.
//
// Pure functions over a store entry — no state of their own. Must load
// before chat-stream-reducer.js / chat-stream-store.js (app.html order).

(function() {
  function nextId(e) {
    e.blockSeq = (e.blockSeq || 0) + 1;
    return 'b' + e.blockSeq;
  }

  function resetBlocks(e) {
    e.blocks = [];
    e.blockBoundary = false;
  }

  // A tool ran (or a replayed delta carries the server's boundary stamp):
  // the next text/reasoning delta starts a NEW block instead of merging.
  function markBlockBoundary(e) {
    e.blockBoundary = true;
  }

  function appendLane(e, type, s) {
    if (!s) return;
    const tail = e.blocks[e.blocks.length - 1];
    if (tail && tail.type === type && !e.blockBoundary) {
      tail.text += s;
    } else {
      e.blocks.push({ id: nextId(e), type, text: s });
    }
    e.blockBoundary = false;
  }

  function appendBlockText(e, s) { appendLane(e, 'text', s); }
  function appendBlockReasoning(e, s) { appendLane(e, 'reasoning', s); }

  // `replace` semantics for one lane (mirrors the content/reasoning lane
  // replace): drop every block of that lane, then append one block holding
  // the authoritative text at the tail. Positional history for the lane is
  // gone by definition — the extractor's replace means "the text you
  // streamed was wrong wholesale", and the replay wipe rebuilds positions
  // from the run deltas that follow it.
  function replaceBlockLane(e, type, text) {
    e.blocks = e.blocks.filter(b => b.type !== type);
    if (text) e.blocks.push({ id: nextId(e), type, text });
    e.blockBoundary = false;
  }

  // Mid-turn user message: lands at the tail of the timeline — right under
  // everything the agent has said so far; the agent's next output opens a
  // new block beneath it.
  function addInjectBlock(e, injectId, text, queueState) {
    e.blocks.push({
      id: nextId(e), type: 'inject', injectId,
      text: text || '', ts: Date.now(),
      queueState: queueState || 'queued',
    });
    e.blockBoundary = true;
  }

  // Flip a queued inject to consumed. When the block is missing but the
  // event carries the text (server replay after a mid-turn reload — the
  // local echo died with the tab), materialize it at the tail so the
  // rebuilt timeline still shows the message where it was consumed.
  // `allowMaterialize` is false once the turn is over: a promote already
  // re-homed the blocks, and materializing onto dead scratch would leak
  // into the NEXT turn's timeline.
  function consumeInjectBlock(e, injectId, text, allowMaterialize) {
    const b = e.blocks.find(x => x.type === 'inject' && x.injectId === injectId);
    if (b) {
      if (b.queueState === 'consumed') return false;
      b.queueState = 'consumed';
      return true;
    }
    if (allowMaterialize && text) {
      addInjectBlock(e, injectId, text, 'consumed');
      return true;
    }
    return false;
  }

  // Promote-time split: consumed injects stay inline in the finalized row's
  // _blocks (the agent answered around them); still-queued ones were never
  // seen by this turn — they belong to the NEXT turn, so the caller
  // re-emits them as standalone user rows after the assistant row.
  function splitQueuedInjects(blocks) {
    const kept = [], queued = [];
    for (const b of blocks || []) {
      if (b.type === 'inject' && b.queueState === 'queued') queued.push(b);
      else if (b.type === 'inject' || (b.text || '').trim()) kept.push(b);
    }
    return { kept, queued };
  }

  // Copy for the finalized message so later scratch resets can't mutate
  // what was promoted.
  function snapshotBlocks(blocks) {
    return (blocks || []).map(b => ({ ...b }));
  }

  window._ChatBlocks = {
    resetBlocks, markBlockBoundary,
    appendBlockText, appendBlockReasoning, replaceBlockLane,
    addInjectBlock, consumeInjectBlock,
    splitQueuedInjects, snapshotBlocks,
  };
})();
