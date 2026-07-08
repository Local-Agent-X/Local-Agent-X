// Wave-2 soak analyzer: joins the battery's raw results with the isolated
// data dir's op store and server log, and reports per-mechanism findings.
//
// Run from repo root with the soak data dir env so src store readers resolve:
//   LAX_DATA_DIR=$HOME/lax-soak node --import=tsx scratchpad-path/analyze.mjs <battery-json>
//
// C1 caveat, stated honestly: the "estimate" recomputed here replays
// op-messages through toChatParams+totalTokens WITHOUT the per-turn view
// reshaping (collapseAdjacentUserMessages / digest prepend), so per-turn
// estimate figures are an approximation of what the live path computed —
// good for magnitude/drift comparison, not for byte-exact replay.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SOAK_DIR = process.env.LAX_DATA_DIR || join(homedir(), "lax-soak");
const batteryPath = process.argv[2];
if (!batteryPath) { console.error("usage: analyze.mjs <battery-json>"); process.exit(2); }
const battery = JSON.parse(readFileSync(batteryPath, "utf-8"));

const { toChatParams } = await import(join(process.cwd(), "src/canonical-loop/turn-loop/compact-history.ts"));
const { totalTokens } = await import(join(process.cwd(), "src/context-manager/token-estimation.ts"));
const { lookupContextWindow } = await import(join(process.cwd(), "src/context-manager/model-windows.ts"));

const opsDir = join(SOAK_DIR, "operations");
const NUDGE_MARKER = "changed on disk OUTSIDE your own tool calls";
const STUB_MARKER = /unchanged since/i;

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// session -> ops join
const ops = [];
for (const opId of existsSync(opsDir) ? readdirSync(opsDir) : []) {
  try {
    const op = JSON.parse(readFileSync(join(opsDir, opId, "operation.json"), "utf-8"));
    const sessionId = op?.canonical?.sessionId;
    if (!sessionId || !sessionId.startsWith(battery.tag)) continue;
    const turnsDir = join(opsDir, opId, "op-turns");
    const turns = existsSync(turnsDir)
      ? readdirSync(turnsDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(turnsDir, f), "utf-8"))).sort((a, b) => a.turnIdx - b.turnIdx)
      : [];
    const messages = readJsonl(join(opsDir, opId, "op-messages.jsonl"));
    ops.push({ opId, sessionId, turns, messages });
  } catch { /* skip malformed */ }
}

// ── C1: anchor engagement + drift ──
const c1 = { turnsWithUsage: 0, anchorEligible: 0, refusals: { noStamp: 0, compacted: 0, tools: 0, cacheAbsent: 0, adapter: 0, model: 0, overWindow: 0 }, deltas: [] };
for (const op of ops) {
  for (const row of op.turns) {
    const ps = row.providerState || {};
    const pp = ps.providerPayload || {};
    const hasUsage = [pp.usageInputTokens, pp.usageOutputTokens].every((v) => typeof v === "number");
    if (!hasUsage) continue;
    c1.turnsWithUsage++;
    if (typeof ps.viewCompacted !== "boolean") { c1.refusals.noStamp++; continue; }
    if (ps.viewCompacted === true) { c1.refusals.compacted++; continue; }
    if (Array.isArray(row.observedTools) && row.observedTools.length > 0) { c1.refusals.tools++; continue; }
    if (typeof pp.cacheReadTokens !== "number" || typeof pp.cacheCreateTokens !== "number") { c1.refusals.cacheAbsent++; continue; }
    if (ps.adapterName !== "anthropic") { c1.refusals.adapter++; continue; }
    const model = pp.model;
    if (typeof model !== "string" || !model) { c1.refusals.model++; continue; }
    const anchorTokens = pp.usageInputTokens + pp.cacheReadTokens + pp.cacheCreateTokens + pp.usageOutputTokens;
    if (anchorTokens > lookupContextWindow(model)) { c1.refusals.overWindow++; continue; }
    c1.anchorEligible++;
    // Approximate the pure estimate of the view AS OF this turn (rows with turnIdx <= this one).
    const view = op.messages.filter((m) => typeof m.turnIdx === "number" && m.turnIdx <= row.turnIdx);
    if (view.length) {
      const est = totalTokens(toChatParams(view));
      c1.deltas.push({ opId: op.opId, turnIdx: row.turnIdx, anchorTokens, estimate: est, ratio: est / Math.max(1, anchorTokens) });
    }
  }
}

// ── E9: nudges + stubs ──
const e9 = { nudgeMessages: 0, nudgesBySession: {}, stubsSeen: 0, stubTurns: [] };
for (const op of ops) {
  for (const m of op.messages) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (content.includes(NUDGE_MARKER)) {
      e9.nudgeMessages++;
      e9.nudgesBySession[op.sessionId] = (e9.nudgesBySession[op.sessionId] || 0) + 1;
    }
  }
}
for (const sess of battery.sessions.filter((s) => s.kind === "churn")) {
  for (const turn of sess.turns) {
    for (const te of turn.toolEnds || []) {
      if (te.result && STUB_MARKER.test(te.result)) { e9.stubsSeen++; e9.stubTurns.push(`${sess.sid}/${turn.label}`); }
    }
  }
}

// ── D2: extraction gate ──
const logPath = join(SOAK_DIR, "logs", "server.log");
const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
const d2 = {
  extractionLogLines: (log.match(/end-of-turn|extraction/gi) || []).length,
  coalescerLines: (log.match(/coalesc/gi) || []).length,
  userMd: null,
};
const userMdPath = join(SOAK_DIR, "memory", "USER.md");
if (existsSync(userMdPath)) d2.userMd = readFileSync(userMdPath, "utf-8").slice(0, 1500);

// ── B2: must be silent ──
const b2 = { trips: (log.match(/circuit breaker tripped/g) || []).length, recoveries: (log.match(/summarization recovered/g) || []).length };

// ── compaction sightings (from live context_status) ──
const compactions = [];
for (const sess of battery.sessions.filter((s) => s.kind === "anchor")) {
  for (const t of sess.turns) {
    for (const cs of t.contextStatus || []) if (cs.compacted) compactions.push(`${sess.sid} t${t.t} @${cs.pct}%`);
  }
}
const errTurns = battery.sessions.flatMap((s) => (s.turns || []).filter((t) => t.err).map((t) => `${s.sid}: ${t.err}`));

// ── report ──
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");
const ratios = c1.deltas.map((d) => d.ratio).sort((a, b) => a - b);
const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;

console.log(JSON.stringify({
  tag: battery.tag,
  provider: battery.provider,
  ops: ops.length,
  errors: errTurns,
  c1: {
    turnsWithUsage: c1.turnsWithUsage,
    anchorEligible: c1.anchorEligible,
    engagement: pct(c1.anchorEligible, c1.turnsWithUsage),
    refusals: c1.refusals,
    medianEstimateOverAnchor: med,
    worstOver: ratios.at(-1) ?? null,
    worstUnder: ratios[0] ?? null,
    samples: c1.deltas.slice(0, 8),
  },
  e9,
  d2,
  b2,
  compactions,
}, null, 2));
