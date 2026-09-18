#!/usr/bin/env node
// What the model actually sees after compaction.
//
// The compacted view is ephemeral — rebuilt each turn, never persisted — so a
// finished run leaves no summary to read. This replays a real op's history
// through the same summarizer the loop uses and prints the summary next to the
// messages it replaced, so its QUALITY can be judged rather than inferred from
// re-read counts.
//
// Run with nothing else on the GPU.
//   node eval/compaction-quality.mjs <evidence-dir>/<slug> [headRows]
//
// LAX_DATA_DIR should point at a settings dir naming the provider/model to
// summarize with (the bench harness passes the eval's own).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
const headRows = Number(process.argv[3] ?? 120);
if (!dir) { console.error("usage: compaction-quality.mjs <evidence-dir>/<slug> [headRows]"); process.exit(2); }

const src = (rel) => pathToFileURL(join(process.cwd(), rel)).href;
const { summarizeOldMessages } = await import(src("src/context-manager/compaction.ts"));
const { toChatParams } = await import(src("src/canonical-loop/turn-loop/compact-history.ts"));

/** Every committed message of the op, in order — the same rows buildTurnInput replays. */
function historyOf(opDir) {
  const rows = [];
  const seed = join(opDir, "op-messages.jsonl.gz");
  if (existsSync(seed)) {
    for (const line of gunzipSync(readFileSync(seed)).toString().trim().split("\n")) {
      if (line) rows.push(JSON.parse(line));
    }
  }
  const turns = join(opDir, "op-turns");
  for (const f of readdirSync(turns).sort((a, b) => parseInt(a) - parseInt(b))) {
    rows.push(...JSON.parse(gunzipSync(readFileSync(join(turns, f))).toString()).messages ?? []);
  }
  return rows;
}

const ops = readdirSync(join(dir, "operations"));
const opDir = join(dir, "operations", ops[ops.length - 1]);
const rows = historyOf(opDir);
const head = rows.slice(0, headRows);
const params = toChatParams(head);
const chars = JSON.stringify(params).length;

console.log(`op ${ops[ops.length - 1]}: ${rows.length} messages; summarizing the first ${head.length} (~${Math.round(chars / 4)} tokens)\n`);
console.log("=== WHAT IT REPLACES (first and last few rows) ===");
for (const m of [...params.slice(0, 3), { role: "…", content: `… ${params.length - 6} rows …` }, ...params.slice(-3)]) {
  console.log(`  [${m.role}] ${String(m.content).replace(/\s+/g, " ").slice(0, 160)}`);
}

const startedAt = performance.now();
const summary = await summarizeOldMessages(params);
const ms = Math.round(performance.now() - startedAt);

console.log(`\n=== SUMMARY (${ms}ms, ${summary ? `${summary.length} chars ≈ ${Math.round(summary.length / 4)} tokens` : "NULL — summarizer failed"}) ===`);
console.log(summary ?? "(none — the loop would elide this history instead)");
if (summary) {
  console.log(`\ncompression: ~${Math.round(chars / 4)} tokens → ~${Math.round(summary.length / 4)} (${(chars / summary.length).toFixed(1)}x)`);
}
process.exit(0);
