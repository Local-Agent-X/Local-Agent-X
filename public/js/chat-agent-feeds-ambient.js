// ── Agent Feeds — AMBIENT ops (dream / cron) ──
// Pure helpers that tell the background ops apart from the user's own work.
// The jobs layout (chat-agent-feeds-jobs.js) lists live ambient ops under a
// collapsed "Ambient" group and finished ones in the Finished drawer, so
// nothing here renders. Load order in app.html: render → this → jobs.
//
// Dream = memory_consolidation, research/cron = scheduled_mission.

const AMBIENT_OP_TYPES = { memory_consolidation: 1, scheduled_mission: 1 };
function isAmbientType(type) { return !!AMBIENT_OP_TYPES[type]; }

// Pure: split the feeds map into { ambient, main } by op type. MAIN feeds
// buildAgentFeedTree unchanged (byte-identical when no ambient agents exist).
function partitionAmbient(dataMap) {
  var map = dataMap || {}, ambient = {}, main = {}, ids = Object.keys(map);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], rec = map[id] || {};
    if (isAmbientType(rec.type)) ambient[id] = rec; else main[id] = rec;
  }
  return { ambient: ambient, main: main };
}

// Compact ambient "activity" word (dream → dreaming, cron → scanning), shown
// as the kind of a live ambient task card.
function ambientStatusLabel(agent) {
  if (agent.type === 'memory_consolidation') return 'dreaming';
  if (agent.type === 'scheduled_mission') return 'scanning';
  return agent.status || 'ambient';
}
