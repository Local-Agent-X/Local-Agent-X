#!/usr/bin/env node
// Recover chat message times and ids from the op records (src/memory/session-time-backfill.ts).
//
//   node --import=tsx scripts/backfill-session-times.ts           # dry run: print the plan
//   node --import=tsx scripts/backfill-session-times.ts --apply   # rewrite (backs up every session log first)
//
// Quit the app first: the running server caches sessions and would write its
// cached times back over the repair on its next save. --apply refuses while
// the server answers.
import { loadConfig, setRuntimeConfig, getRuntimeConfig } from "../src/config.js";
import { getLaxDir } from "../src/lax-data-dir.js";

setRuntimeConfig(loadConfig());
const { planAllSessions, applyAllSessions } = await import("../src/memory/session-time-backfill.js");
const { readOpMessages } = await import("../src/canonical-loop/index.js");
const laxDir = getLaxDir();
const plans = planAllSessions(laxDir, readOpMessages);
const sum = (k: "turns" | "matched" | "unknown") => plans.reduce((n, p) => n + p[k], 0);
const rows = plans.flatMap((p) => p.times);
console.log(`sessions=${plans.length} turns=${sum("turns")} matched=${sum("matched")} unknown=${sum("unknown")} rows=${rows.length} opIds=${rows.filter((t) => t.id).length}`);
for (const id of process.argv.filter((a) => a.startsWith("chat-"))) {
  const p = plans.find((x) => x.sessionId === id);
  if (!p) { console.log(`${id}: no such session`); continue; }
  console.log(`\n${id}: turns=${p.turns} matched=${p.matched} unknown=${p.unknown}`);
  for (const t of p.times) console.log(`  ${t.before.slice(0, 19)} -> ${t.createdAt ? t.createdAt.slice(0, 19) : "UNKNOWN            "}  ${t.preview}`);
}
if (!process.argv.includes("--apply")) {
  console.log("\nDry run. Re-run with --apply to rewrite (session logs are backed up first).");
} else {
  const port = getRuntimeConfig().port;
  const up = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true, () => false);
  if (up) { console.error(`Refusing: Local Agent X is running on :${port}. Quit it first.`); process.exit(1); }
  const backup = applyAllSessions(laxDir, plans, new Date().toISOString().replace(/[:.]/g, "-"));
  console.log(`Applied. Backup of every session log: ${backup}`);
}

// Importing the canonical-loop store (readOpMessages) leaves timers on the
// event loop; this is a one-shot script, so end it explicitly.
process.exit(0);
