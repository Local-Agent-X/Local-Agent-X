// ── ChatStreamStore: WS-event reducer ──
//
// The applyEvent switch body — mutates one store entry from a raw WS event.
// Extracted from chat-stream-store.js so the store core stays under the
// 400-LOC gate. Pure over the entry: no maps, no subscribers, no notify —
// the core owns those and calls this, then notifies.
//
// Every text-bearing case updates BOTH representations in lockstep:
//   - the flat lanes (e.content / e.reasoning) — persistence, TTS, the
//     error-dedup guard, and the render throttle read these;
//   - the ordered block timeline (e.blocks, via _ChatBlocks) — the renderer
//     walks this, so thinking/text/inject appear in arrival order.
//
// `event.boundary === true` on a delta is the server's replay stamp for "a
// tool ran right before this" (replay.ts sends wipe + ordered run deltas;
// the interleaved tool events themselves replay afterwards). Live turns
// don't need it — the tool_start/tool_end cases mark the boundary locally.
//
// Must load before chat-stream-store.js (app.html order).

(function() {
  window._chatStreamReduce = function(e, event, now, helpers) {
    const B = window._ChatBlocks;
    switch (event.type) {
      case 'chat_op_started':
        if (event.opId && e.doneOpIds.has(event.opId)) {
          // Stale start for an op we've already ended. Don't overwrite the
          // current opId with the dead one and don't re-light streaming.
          e.lastActivityMs = now;
          break;
        }
        if (event.opId) e.opId = event.opId;
        if (e.status === 'done') {
          // A NEW op starting on a finished entry (the doneOpIds guard above
          // already rejected stale replays). Adopted turns never ran
          // startTurn, so scratch left behind after the last promote — a late
          // '\n\nError: …' appended AFTER promote cleared content — would
          // become the head of this turn and get persisted. Mirror startTurn's
          // scratch resets; leave liveAnchorIndex/doneOpIds alone (adoption
          // owns the anchor; doneOpIds must keep rejecting stale starts).
          //
          // Replay-ordering guarantee (state.ts replayBufferedEvents): on a
          // subscribe replay the server sends ALL chat_op_started events
          // FIRST, then the per-lane wipes and ordered run deltas, then the
          // remaining buffered events. Same-tab reconnect onto an entry still
          // 'done' from its last turn: the new op's replayed chat_op_started
          // fires this wipe BEFORE the runs refill content — a genuinely new
          // op, nothing lost. Page reload: the entry is fresh ('idle'), the
          // wipe doesn't fire, the replay lands untouched either way.
          e.content = '';
          e.reasoning = '';
          e.toolsSinceText = false;
          e.toolEvents = [];
          e.chips = [];
          e.progressByTool = {};
          e.approvals = [];
          e.stopNote = null;
          e.abortReason = null;
          B.resetBlocks(e);
        }
        if (e.status === 'idle' || e.status === 'done') e.status = 'streaming';
        e.lastActivityMs = now;
        break;
      case 'stream':
        if (event.replace === true) {
          e.content = event.text || '';
          e.toolsSinceText = false;
          B.replaceBlockLane(e, 'text', e.content);
        } else if (typeof event.delta === 'string') {
          // The paragraph break is part of the appended text so the block
          // timeline and the flat lane stay byte-identical.
          let s = event.delta;
          if (e.toolsSinceText && e.content && !e.content.endsWith('\n')) s = '\n\n' + s;
          e.content += s;
          e.toolsSinceText = false;
          if (event.boundary === true) B.markBlockBoundary(e);
          B.appendBlockText(e, s);
        }
        e.lastActivityMs = now;
        // Visible progress — see the lastContentMs comment in blank().
        e.lastContentMs = now;
        break;
      case 'reasoning':
        // Live chain-of-thought — its own lane so it never pollutes the
        // answer text or persisted content, and its own blocks so it renders
        // at the point in the turn where it actually streamed.
        // `replace` is the replay-coalescing/wipe frame (replay.ts) — same
        // duplication class as the stream lane: appending replayed deltas
        // onto reasoning this client already holds double-counts the
        // Thinking text, so the server wipes and we SET instead of append.
        if (event.replace === true) {
          e.reasoning = event.text || '';
          B.replaceBlockLane(e, 'reasoning', e.reasoning);
        } else if (typeof event.delta === 'string') {
          e.reasoning += event.delta;
          if (event.boundary === true) B.markBlockBoundary(e);
          B.appendBlockReasoning(e, event.delta);
        }
        e.lastActivityMs = now;
        e.lastContentMs = now;
        break;
      case 'tool_start':
        // Idempotent by call id. The same tool_start can reach the store more
        // than once for a single dispatch (provider/transport replays, a
        // resubscribed WS listener). A duplicate start would render a second
        // tool card AND a second generate_image preview, so dedupe at the
        // source of truth rather than papering over it downstream.
        if (!event.toolCallId || !e.toolEvents.some(t => t.type === 'start' && t.toolCallId === event.toolCallId)) {
          e.toolEvents.push({ type: 'start', name: event.toolName, toolCallId: event.toolCallId, args: event.args, riskLevel: event.riskLevel });
        }
        e.toolsSinceText = true;
        B.markBlockBoundary(e);
        e.lastActivityMs = now;
        e.lastContentMs = now;
        break;
      case 'tool_end': {
        // Preserve the media URL line through the 500-char cap so
        // chat-tool-cards.js attachMediaPreview can still render the
        // <img>/<video>. Long video prompts routinely push the trailing
        // `View: /videos/...` line past the cap, leaving the chat bubble
        // with the tool-detail text but no inline player or link.
        const raw = event.result || '';
        let result = raw.slice(0, 500);
        const mediaUrl = raw.match(/\/(?:images|videos)\/[A-Za-z0-9._-]+/);
        if (mediaUrl && !result.includes(mediaUrl[0])) {
          result = result.trimEnd() + '\nView: ' + mediaUrl[0];
        }
        // Idempotent by call id, same reasoning as tool_start above.
        // `metadata` is the result envelope's metadata (layer/recovery/…) —
        // kept so the renderer can key affordances off the blocking layer
        // (declassify-and-retry on a data-lineage / tainted-shell block).
        if (!event.toolCallId || !e.toolEvents.some(t => t.type === 'end' && t.toolCallId === event.toolCallId)) {
          e.toolEvents.push({ type: 'end', name: event.toolName, toolCallId: event.toolCallId, allowed: event.allowed, status: event.status, result, metadata: event.metadata });
        }
        e.toolsSinceText = true;
        B.markBlockBoundary(e);
        e.lastActivityMs = now;
        e.lastContentMs = now;
        break;
      }
      case 'tool_chip':
        if (event.chip) e.chips.push(event.chip);
        e.lastActivityMs = now;
        e.lastContentMs = now;
        break;
      case 'tool_progress':
        if (event.toolName) {
          e.progressByTool[event.toolName] = { message: event.message || '' };
        }
        e.lastActivityMs = now;
        e.lastContentMs = now;
        break;
      case 'approval_requested':
        // Idempotent by approvalId — the same ask can reach the store twice
        // (live event + connect-time rediscovery hydration from
        // /api/approvals/pending, or a replayed frame). A duplicate would
        // render two actionable cards for one decision.
        if (event.approvalId && !e.approvals.some(a => a.id === event.approvalId)) {
          e.approvals.push({
            id: event.approvalId,
            toolName: event.toolName,
            context: event.context,
            argsPreview: event.argsPreview,
            // Durable-sourced asks (chat-ws.js rediscovery) carry the op id +
            // expiry so the answer can route via the durable-resolve path and
            // the card can expire client-side; live asks omit both → null.
            opId: event.opId || null,
            expiresAt: typeof event.expiresAt === 'number' ? event.expiresAt : null,
            status: 'pending',
            resolvedAt: null,
          });
        }
        e.lastActivityMs = now;
        break;
      case 'approval_timeout': {
        if (event.approvalId) {
          const ap = e.approvals.find(a => a.id === event.approvalId);
          if (ap) { ap.status = 'timeout'; ap.resolvedAt = now; }
        }
        e.lastActivityMs = now;
        break;
      }
      case 'approval_resolved': {
        // Without this the store only ever knew pending/timeout, so any
        // re-render during the turn resurrected a clicked card as a fresh
        // actionable prompt.
        if (event.approvalId) {
          const ap = e.approvals.find(a => a.id === event.approvalId);
          if (ap) {
            ap.status = event.approved ? 'approved' : 'denied';
            ap.resolvedAt = now;
            // Durable-resolve reply: the decision was recorded on the op's
            // durable column (server restarted since the ask) and applies
            // when the agent resumes — render distinctly from a live settle.
            if (event.delivery === 'recorded') ap.delivery = 'recorded';
          }
        }
        e.lastActivityMs = now;
        break;
      }
      case 'stopped':
        e.stopNote = {
          reason: event.reason || 'Stopped.',
          debug: event.debug || null,
          firedBy: event.firedBy || null,
        };
        e.lastActivityMs = now;
        break;
      case 'error':
        if (event.message) {
          e.abortReason = event.message;
          // Mirror the error into the visible bubble text. Dedup guards
          // against duplicate WS deliveries (server's emitErrorOnce dedups
          // per-op, but accumulated subscribers can still re-deliver — see
          // 2026-05-27 live trace: 4 identical error bubbles from one
          // server event).
          const errText = '\n\nError: ' + event.message;
          if (!e.content.endsWith(errText)) {
            e.content += errText;
            B.markBlockBoundary(e);
            B.appendBlockText(e, errText);
          }
        }
        e.lastActivityMs = now;
        break;
      case 'done':
        helpers.rememberDoneOp(e, e.opId);
        e.status = 'done';
        e.opId = null;
        e.lastActivityMs = now;
        break;
      default:
        // Deliberately does NOT bump lastContentMs: op_heartbeat lands here,
        // and heartbeats must not mask content-idleness — the idle thinking
        // indicator exists precisely to show during heartbeat-only stretches.
        e.lastActivityMs = now;
    }
  };
})();
