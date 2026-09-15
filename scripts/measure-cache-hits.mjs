#!/usr/bin/env node
/**
 * measure-cache-hits.mjs — MEASUREMENT ONLY. Reads recorded chat operations
 * from the LAX data dir and reports how well the Anthropic prompt cache is
 * actually hitting, so cache changes are judged on real traffic:
 *
 *   1. FIRST CALL PER MESSAGE — cache read/write on turn 0 of each chat op,
 *      bucketed by the pause since the previous op in the same session
 *      (<5 min: 5-minute cache should hold; 5-60 min: only the 1-hour
 *      breakpoint can hold; >60 min: expected cold). A "full miss" reads
 *      under 1k tokens.
 *   2. WITHIN-OP REWRITES — cache tokens written on rounds after the first vs
 *      the prompt's actual growth. Writes far above growth mean a breakpoint
 *      sits on bytes that change every round.
 *   3. SEEDED-HISTORY STABILITY — whether each op's seeded history starts
 *      with the previous op's messages byte-for-byte. When it doesn't, the
 *      conversation cache can't hit across messages no matter where the
 *      breakpoints are.
 *
 *   node scripts/measure-cache-hits.mjs [--since 2026-09-15] [--json]
 *
 * Data dir: $LAX_DATA_DIR, else ~/.lax. Read-only; touches nothing.
 * Local models record no token counts, so only Anthropic ops are measured.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const sinceArg = args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined;
const since = sinceArg ? Date.parse(sinceArg) : 0;
const asJson = args.includes("--json");
const root = join(process.env.LAX_DATA_DIR || join(homedir(), ".lax"), "operations");

if (!existsSync(root)) {
  console.error(`No operations directory at ${root}`);
  process.exit(1);
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const ops = [];
for (const id of readdirSync(root)) {
  if (!id.startsWith("op_chat_turn_")) continue;
  const dir = join(root, id);
  const op = readJson(join(dir, "operation.json"));
  if (!op) continue;
  const created = Date.parse(op.startedAt || op.createdAt);
  if (!(created >= since)) continue;
  const turnsDir = join(dir, "op-turns");
  const turns = existsSync(turnsDir)
    ? readdirSync(turnsDir).map((f) => readJson(join(turnsDir, f))?.turn).filter(Boolean).sort((a, b) => a.turnIdx - b.turnIdx)
    : [];
  let rows = [];
  try {
    rows = readFileSync(join(dir, "op-messages.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* no messages recorded */ }
  const usage = turns.map((t) => t.providerState?.providerPayload ?? {});
  ops.push({
    id,
    sessionId: op.sessionId,
    start: created,
    end: Date.parse(op.completedAt || turns.at(-1)?.createdAt || op.createdAt),
    anthropic: turns[0]?.providerState?.adapterName === "anthropic",
    usage: usage.map((u) => ({ read: u.cacheReadTokens || 0, write: u.cacheCreateTokens || 0, input: u.usageInputTokens || 0 })),
    rows,
  });
}
ops.sort((a, b) => a.start - b.start);

// 1. First call per message.
const buckets = { firstInSession: [], under5m: [], from5to60m: [], over60m: [] };
const previousInSession = new Map();
for (const op of ops) {
  const prev = previousInSession.get(op.sessionId);
  previousInSession.set(op.sessionId, op);
  if (!op.anthropic || op.usage.length === 0) continue;
  const first = op.usage[0];
  if (!prev) { buckets.firstInSession.push(first); continue; }
  const gapMin = (op.start - prev.end) / 60000;
  (gapMin < 5 ? buckets.under5m : gapMin < 60 ? buckets.from5to60m : buckets.over60m).push(first);
}
const firstCall = Object.fromEntries(Object.entries(buckets).map(([name, calls]) => [name, {
  ops: calls.length,
  medianRead: median(calls.map((c) => c.read)),
  medianWrite: median(calls.map((c) => c.write)),
  fullMisses: calls.filter((c) => c.read < 1000).length,
}]));

// 2. Within-op rewrites.
let laterRounds = 0, laterWrites = 0, growth = 0, rewriteRounds = 0;
for (const op of ops) {
  if (!op.anthropic) continue;
  for (let i = 1; i < op.usage.length; i++) {
    const p = op.usage[i - 1], c = op.usage[i];
    laterRounds++;
    laterWrites += c.write;
    growth += Math.max(0, c.read + c.write - (p.read + p.write + p.input));
    if (c.write > 20000 && c.write > 0.5 * (c.read + c.write)) rewriteRounds++;
  }
}

// 3. Seeded-history stability.
const key = (r) => `${r.role}|${JSON.stringify(r.content)}`;
let pairs = 0, prefixStable = 0;
previousInSession.clear();
for (const op of ops) {
  const prev = previousInSession.get(op.sessionId);
  previousInSession.set(op.sessionId, op);
  if (!prev) continue;
  const before = prev.rows.map(key);
  const seeded = op.rows.filter((r) => String(r.messageId).startsWith("hist-")).map(key);
  pairs++;
  if (seeded.length >= before.length && before.every((k, i) => k === seeded[i])) prefixStable++;
}

const report = {
  since: sinceArg ?? null,
  chatOps: ops.length,
  anthropicChatOps: ops.filter((o) => o.anthropic).length,
  firstCall,
  withinOp: { laterRounds, cacheWrites: laterWrites, promptGrowth: growth, rewriteRounds },
  seededHistory: { consecutivePairs: pairs, prefixStable },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Chat ops: ${report.chatOps} (Anthropic: ${report.anthropicChatOps})${sinceArg ? ` since ${sinceArg}` : ""}`);
  console.log("\nFirst call per message (by pause since the previous message):");
  for (const [name, b] of Object.entries(firstCall)) {
    console.log(`  ${name.padEnd(15)} ops=${String(b.ops).padStart(4)}  median read=${String(b.medianRead).padStart(7)}  median write=${String(b.medianWrite).padStart(7)}  full misses=${b.fullMisses}`);
  }
  console.log("\nWithin-op rounds after the first:");
  console.log(`  rounds=${laterRounds}  cache writes=${laterWrites}  actual prompt growth=${growth}  rounds re-writing most of the prompt=${rewriteRounds}`);
  console.log("\nSeeded history vs previous op:");
  console.log(`  ${prefixStable} of ${pairs} consecutive pairs start with the previous op's messages exactly`);
}
