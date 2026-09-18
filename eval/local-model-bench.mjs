#!/usr/bin/env node
// One model or two? Measures what a small routing model actually saves.
//
// LAX splits background model calls: REVIEW (judging, summarizing, or
// constraining the worker's own output) runs on the worker's model; ROUTING
// (cheap triage whose mistake cannot block the work) runs on a small
// background model, if the user pinned or discovered one. Keeping that small
// model resident costs VRAM — the question is whether it buys enough speed to
// be worth the second model on a single-GPU box.
//
// Run with NOTHING else on the GPU: a concurrent eval makes every number a
// measurement of contention (that mistake produced a bogus "muse runs at
// 10 tok/s" reading on 2026-09-17).
//
//   node eval/local-model-bench.mjs                      # both models, real prompts
//   node eval/local-model-bench.mjs --reload             # also time a cold load
//
// Reports per-call latency, a per-turn total at the observed call mix, and the
// cold-load penalty a model eviction would cost.

import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.LAX_OLLAMA_URL?.replace(/\/+$/, "") ?? "http://127.0.0.1:11434";
const WORKER = process.env.BENCH_WORKER ?? "muse-glimmer:30b";
const ROUTER = process.env.BENCH_ROUTER ?? "llama3.2:3b-classifier";
const RELOAD = process.argv.includes("--reload");

/** The routing calls a single chat turn actually makes (categories from the
 *  Phase 0 inventory). Prompts are the real shapes, trimmed to their essentials. */
const ROUTING_CALLS = [
  {
    category: "end-of-turn-write",
    system: "Decide whether this exchange contains a durable fact worth writing to memory. Reply with JSON: {\"write\":true|false,\"fact\":\"...\"}",
    user: "User: the deploy script lives in ops/deploy.sh, not scripts/.\nAssistant: Noted — I'll use ops/deploy.sh from now on.",
  },
  {
    category: "curate-teach-moment",
    system: "Is the user teaching a durable preference here? Reply with JSON: {\"teach\":true|false}",
    user: "User: stop asking before you run the tests, just run them.",
  },
  {
    category: "topical-relevance",
    system: "Which of these recalled notes are on-topic for the message? Reply with JSON: {\"keep\":[index,...]}",
    user: "Message: fix the failing wordy test.\nNotes:\n0. User prefers pytest over unittest\n1. User's deploy script is ops/deploy.sh\n2. wordy raises ValueError with distinct messages",
  },
  {
    category: "followup",
    system: "Classify the message as FOLLOWUP, RESUME, or NEW. Reply with JSON: {\"verdict\":\"...\"}",
    user: "and now do the same for phone-number",
  },
];

async function generate(model, system, user, { think = false, keepAlive = "30m", numPredict = 120 } = {}) {
  const body = {
    model,
    prompt: `${system}\n\n---\n\n${user}`,
    stream: false,
    keep_alive: keepAlive,
    options: { temperature: 0, num_predict: numPredict },
  };
  if (think === false) body.think = false;
  const startedAt = performance.now();
  const res = await fetch(`${BASE}/api/generate`, { method: "POST", body: JSON.stringify(body) });
  const json = await res.json();
  return {
    wallMs: performance.now() - startedAt,
    loadMs: (json.load_duration ?? 0) / 1e6,
    promptTokens: json.prompt_eval_count ?? 0,
    outTokens: json.eval_count ?? 0,
    text: String(json.response ?? "").trim(),
  };
}

async function resident() {
  const ps = await (await fetch(`${BASE}/api/ps`)).json();
  return ps.models.map((m) => `${m.name} (${Math.round(m.size_vram / 1e9)}GB, ctx ${m.context_length})`);
}

async function benchRouting(model) {
  // One warm-up so the first measured call is not paying a load.
  await generate(model, "Reply with OK.", "OK?", { numPredict: 8 });
  const rows = [];
  for (const call of ROUTING_CALLS) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await generate(model, call.system, call.user));
      await sleep(200);
    }
    runs.sort((a, b) => a.wallMs - b.wallMs);
    const median = runs[1];
    rows.push({ category: call.category, ms: Math.round(median.wallMs), prompt: median.promptTokens, out: median.outTokens });
  }
  return rows;
}

function report(model, rows) {
  console.log(`\n${model}`);
  for (const r of rows) {
    console.log(`  ${r.category.padEnd(22)} ${String(Math.round(r.ms)).padStart(6)}ms   prompt ${String(r.prompt).padStart(5)}  out ${String(r.out).padStart(4)}`);
  }
  const total = rows.reduce((sum, r) => sum + r.ms, 0);
  console.log(`  ${"per turn (all four)".padEnd(22)} ${String(Math.round(total)).padStart(6)}ms`);
  return total;
}

const main = async () => {
  console.log(`resident before: ${(await resident()).join(", ") || "(none)"}`);
  const routerRows = await benchRouting(ROUTER);
  const workerRows = await benchRouting(WORKER);
  const routerTotal = report(ROUTER, routerRows);
  const workerTotal = report(WORKER, workerRows);

  console.log(`\nper-turn routing cost: ${Math.round(routerTotal)}ms on ${ROUTER} vs ${Math.round(workerTotal)}ms on ${WORKER}`);
  console.log(`difference: ${Math.round(workerTotal - routerTotal)}ms per turn — what the second model buys`);

  if (RELOAD) {
    // The penalty a VRAM eviction costs, which is what a second resident model
    // risks when voice or a bigger model is added.
    await generate(WORKER, "Reply with OK.", "OK?", { keepAlive: "0s", numPredict: 8 });
    await sleep(3000);
    console.log(`resident after unload: ${(await resident()).join(", ") || "(none)"}`);
    const cold = await generate(WORKER, "Reply with OK.", "OK?", { numPredict: 8 });
    console.log(`\n${WORKER} cold load: ${Math.round(cold.loadMs)}ms (first call wall ${Math.round(cold.wallMs)}ms)`);
    console.log(`one eviction costs ~${(cold.loadMs / Math.max(1, workerTotal - routerTotal)).toFixed(1)} turns of the routing difference`);
  }
  console.log(`\nresident after: ${(await resident()).join(", ") || "(none)"}`);
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
