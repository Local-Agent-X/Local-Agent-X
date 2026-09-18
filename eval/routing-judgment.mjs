#!/usr/bin/env node
// Is the small routing model's JUDGMENT good enough for the calls it owns?
//
// Routing calls (memory writes, recall filtering, follow-up detection) run on
// a small background model because their mistakes cannot block the work. That
// is an argument about CONSEQUENCE, not accuracy — this measures accuracy:
// each case has a known-correct answer, and both models answer it.
//
// Run with nothing else on the GPU.
//   node eval/routing-judgment.mjs

const BASE = process.env.LAX_OLLAMA_URL?.replace(/\/+$/, "") ?? "http://127.0.0.1:11434";
const ROUTER = process.env.BENCH_ROUTER ?? "llama3.2:3b-classifier";
const WORKER = process.env.BENCH_WORKER ?? "muse-glimmer:30b";

/** Cases with a defensible right answer, including ones designed to mislead. */
const CASES = [
  {
    name: "durable fact → write",
    system: 'Does this exchange contain a durable fact worth writing to memory? Reply JSON: {"write":true|false}',
    user: "User: the deploy script lives in ops/deploy.sh, not scripts/.",
    expect: (j) => j.write === true,
  },
  {
    name: "transient chatter → no write",
    system: 'Does this exchange contain a durable fact worth writing to memory? Reply JSON: {"write":true|false}',
    user: "User: ok cool, thanks. Assistant: you're welcome.",
    expect: (j) => j.write === false,
  },
  {
    name: "one-off command → no write",
    system: 'Does this exchange contain a durable fact worth writing to memory? Reply JSON: {"write":true|false}',
    user: "User: run the tests again please. Assistant: 25 passed.",
    expect: (j) => j.write === false,
  },
  {
    name: "standing preference → teach moment",
    system: 'Is the user teaching a durable preference? Reply JSON: {"teach":true|false}',
    user: "User: stop asking before you run the tests, just run them.",
    expect: (j) => j.teach === true,
  },
  {
    name: "one-time instruction → not a teach moment",
    system: 'Is the user teaching a durable preference? Reply JSON: {"teach":true|false}',
    user: "User: for this one, skip the tests and just show me the diff.",
    expect: (j) => j.teach === false,
  },
  {
    name: "follow-up vs new task",
    system: 'Classify the message as FOLLOWUP (continues the last task) or NEW. Reply JSON: {"verdict":"FOLLOWUP"|"NEW"}',
    user: "and now do the same for phone-number",
    expect: (j) => j.verdict === "FOLLOWUP",
  },
  {
    name: "new task after a finished one",
    system: 'Classify the message as FOLLOWUP (continues the last task) or NEW. Reply JSON: {"verdict":"FOLLOWUP"|"NEW"}',
    user: "forget that — set up a cron job that emails me the sales report on Mondays",
    expect: (j) => j.verdict === "NEW",
  },
  {
    name: "relevance: keep the on-topic note only",
    system: 'Which recalled notes are on-topic for the message? Reply JSON: {"keep":[index,...]}',
    user: "Message: fix the failing wordy test.\nNotes:\n0. wordy raises ValueError with distinct messages\n1. User's dog is called Rex\n2. User prefers tabs over spaces",
    expect: (j) => Array.isArray(j.keep) && j.keep.includes(0) && !j.keep.includes(1),
  },
];

async function ask(model, c) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    body: JSON.stringify({
      model,
      prompt: `${c.system}\n\nReturn ONLY JSON.\n\n---\n\n${c.user}`,
      stream: false, think: false, keep_alive: "30m",
      options: { temperature: 0, num_predict: 200 },
    }),
  });
  const raw = String((await res.json()).response ?? "");
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match?.[0] ?? raw);
    return { ok: c.expect(parsed), parsed: JSON.stringify(parsed).slice(0, 90) };
  } catch {
    return { ok: false, parsed: `UNPARSEABLE: ${raw.replace(/\s+/g, " ").slice(0, 70)}` };
  }
}

const score = { [ROUTER]: 0, [WORKER]: 0 };
for (const c of CASES) {
  const results = {};
  for (const model of [ROUTER, WORKER]) {
    const r = await ask(model, c);
    if (r.ok) score[model]++;
    results[model] = r;
  }
  console.log(`\n${c.name}`);
  for (const model of [ROUTER, WORKER]) {
    console.log(`  ${results[model].ok ? "OK  " : "MISS"} ${model.padEnd(24)} ${results[model].parsed}`);
  }
}
console.log(`\n${ROUTER}: ${score[ROUTER]}/${CASES.length}   ${WORKER}: ${score[WORKER]}/${CASES.length}`);
process.exit(0);
