/**
 * The build lead's judgment, replayed (`npm run eval:build-lead`).
 *
 * Each case is a decision a build lead was really asked (or a generic one
 * written like it): the chunk's contract, what the review found, the worker's
 * report, the rounds before. The case names the answers that are right and the
 * ones that are wrong; anything else is scored neutral. Every case is sent to a
 * model as the lead would get it (leadPacket, the same text), and its answer is
 * read the way build_decide reads it (readDecision).
 *
 * A change to the engine's decisions used to be judged by the next live build,
 * so a fix for one chunk's failure could undo another's unseen (label-check-sol,
 * 2026-11-24 and 11-25). Run this before and after a change to the lead's role
 * or packet, on the model that leads builds.
 *
 * Cases: eval/build-lead/cases.json (generic, public), plus every *.json in the
 * private holdout's build-lead/ folder (eval/op-outcomes/private.mjs): real
 * builds' decisions stay off a public repo. Results go to that folder's
 * results/, or are only printed when it does not exist.
 *
 * The lead here has no tools: in a build it can read the code and run checks
 * before it answers. A case is judged on the evidence in its packet alone.
 *
 * It talks to no LAX server. Model calls go through classifySchema on the
 * provider LAX is set to (resolved from the data dir, read only), so it needs
 * that provider signed in. It costs one short call per case and repeat.
 *
 *   npm run eval:build-lead -- [--model <id>] [--only <text>] [--repeat N]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { classifySchema } from "../../src/classifiers/schema-output.js";
import { LEAD_ACTIONS, leadPacket, type LeadSituation } from "../../src/auto-build/advisor/lead-decisions.js";
import { readDecision } from "../../src/auto-build/advisor/build-decide-tool.js";
import { privateHoldoutDir } from "../op-outcomes/private.mjs";

interface LeadCase {
  id: string;
  source: string;
  situation: LeadSituation;
  right: string[];
  wrong: string[];
  why: string;
}

type Verdict = "right" | "wrong" | "neutral" | "no-answer";

const HERE = resolve(import.meta.dirname);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadCases(): LeadCase[] {
  const files = [join(HERE, "cases.json")];
  const priv = join(privateHoldoutDir() as string, "build-lead");
  if (existsSync(priv)) files.push(...readdirSync(priv).filter((f) => f.endsWith(".json")).map((f) => join(priv, f)));
  return files.flatMap((f) => JSON.parse(readFileSync(f, "utf-8")) as LeadCase[]);
}

const answerSchema = z.object({ action: z.string(), reasoning: z.string() }).passthrough();

async function decide(c: LeadCase, model: string | undefined): Promise<{ action: string | null; reasoning: string }> {
  const packet = leadPacket("bd-eval", c.situation, true)
    .replace(/Answer with build_decide\([^\n]*$/, "Answer with the arguments you would pass to build_decide, as JSON.");
  const raw = await classifySchema({
    category: "build-lead-eval",
    systemPrompt: "You are the lead of a software build run by an engine. Decide as the message asks.",
    userPrompt: packet,
    schema: answerSchema,
    shapeHint: `{"action":"${LEAD_ACTIONS.join("|")}","reasoning":"...","instruction":"...","follow_ups":["..."],"done_when":"...","question":"...","owed_check":"...","evidence":"...","parts":[{"title":"...","done_when":"..."}]}`,
    role: "review",
    timeoutMs: 180_000,
    // A lead's answer runs to a paragraph or two; the classifier default cuts it mid-string.
    maxResponseChars: 8_000,
    ...(model ? { model } : {}),
  });
  if (!raw) return { action: null, reasoning: "no answer from the model" };
  const decision = readDecision(raw as Record<string, unknown>);
  if ("error" in decision) return { action: null, reasoning: `answer build_decide would refuse: ${decision.error}` };
  return { action: decision.action, reasoning: decision.reasoning };
}

function verdictOf(c: LeadCase, action: string | null): Verdict {
  if (!action) return "no-answer";
  if (c.right.includes(action)) return "right";
  if (c.wrong.includes(action)) return "wrong";
  return "neutral";
}

async function main(): Promise<void> {
  const model = arg("model");
  const only = arg("only");
  const repeat = Number(arg("repeat") ?? 1);
  const cases = loadCases().filter((c) => !only || c.id.includes(only));
  console.log(`${cases.length} case(s), ${repeat} answer(s) each${model ? `, model ${model}` : ""}
`);
  const rows: Array<{ id: string; run: number; action: string | null; verdict: Verdict; reasoning: string }> = [];
  const queue = cases.flatMap((c) => Array.from({ length: repeat }, (_, run) => ({ c, run })));
  const workers = Array.from({ length: 4 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { action, reasoning } = await decide(job.c, model);
      const verdict = verdictOf(job.c, action);
      rows.push({ id: job.c.id, run: job.run, action, verdict, reasoning });
      console.log(`${verdict.padEnd(9)} ${job.c.id}${repeat > 1 ? ` #${job.run + 1}` : ""}: ${action ?? "-"} (right: ${job.c.right.join("/")})`);
    }
  });
  await Promise.all(workers);

  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n${rows.length} answers: ${count("right")} right, ${count("wrong")} wrong, ${count("neutral")} neutral, ${count("no-answer")} no answer`);
  for (const r of rows.filter((x) => x.verdict === "wrong")) {
    const c = cases.find((x) => x.id === r.id)!;
    console.log(`\nWRONG ${r.id}: answered ${r.action}. Why it should not: ${c.why}\n  The model said: ${r.reasoning.slice(0, 400)}`);
  }

  const priv = join(privateHoldoutDir() as string, "build-lead");
  if (rows.length && existsSync(priv)) {
    const dir = join(priv, "results");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${model ?? "default"}.json`);
    writeFileSync(file, JSON.stringify({ model: model ?? "default", repeat, rows }, null, 1));
    console.log(`\nResults: ${file}`);
  }
  process.exit(count("wrong") + count("no-answer") > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
