// GENERATED from src/broker-transport/vendor/timeline.ts by scripts/gen-browser-timeline.mjs. Do not edit:
// change the rule in agentxos, re-sync the vendor folder, then regenerate.
(function () {
  var exports = {};
  // How a receiver applies a `replace` frame (stream or reasoning) to a turn's ordered
  // timeline. The one implementation: the desktop's replay runs, the desktop web client's
  // blocks and the phone's blocks all call it, so a turn renders the same whether a client
  // watched it live or rebuilt it from a replay.
  //
  // The replacement is not a different text. Every real sender hands back a lightly edited
  // derivative of the bytes already streamed (a tool call extracted from the text, the
  // delivery-time repair, the replay wipe ""), so it diverges late or not at all. Keep every
  // item of the lane the replacement still agrees with, byte for byte; only from the first
  // differing byte is positional history void: the rest lands in the item where the
  // divergence began and later items of that lane go away. Items of other lanes never move.
  // Dropping every item of the lane and reseeding one at the tail instead stacks every
  // thinking block of a think → answer → think → answer turn at the top.
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.replaceLane = replaceLane;
  /** The timeline after the lane's text became `text`.
   *  Postcondition: the lane's items, in order, concatenate to `text`. */
  function replaceLane(items, text, ops) {
      const next = [];
      let cursor = 0;
      let diverged = false;
      for (const item of items) {
          const current = ops.laneText(item);
          if (current === null) {
              next.push(item);
              continue;
          }
          if (diverged)
              continue; // the lane's history past the split point is void
          if (text.startsWith(current, cursor)) {
              cursor += current.length;
              next.push(item);
              continue;
          }
          diverged = true;
          const rest = text.slice(cursor);
          cursor = text.length;
          if (rest !== "")
              next.push(ops.withText(item, rest));
      }
      if (!diverged && cursor < text.length)
          next.push(ops.create(text.slice(cursor)));
      return next;
  }
  window.AgentxosTimeline = exports;
})();
