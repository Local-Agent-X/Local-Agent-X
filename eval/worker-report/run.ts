/**
 * Does a model end a chunk with a report the engine can act on
 * (`npm run eval:worker-report`)?
 *
 * The build engine acts on a worker's typed report and on nothing the worker
 * writes in prose (src/auto-build/chunk-review/SKILL.md). So a model that
 * leads builds must put each thing in the field that carries it: a command
 * the machine refused in `machine_blocked` and not a blocked status, a
 * missing credential as a deferral with how to verify it, a choice that is
 * the owner's in `owner_question`, and nothing invented when there is nothing
 * to say. Each case is the end of a chunk: the contract, and what happened in
 * the run. The model gets the worker's own brief and the tool's own
 * description and schema, and answers with the arguments it would pass. The
 * answer is read by the tool's validator (readChunkReport); a refusal is
 * handed back once with the tool's message, as it would be in a build.
 *
 * What this does not measure: whether a model ends its run by CALLING the
 * tool. That takes a real agent turn, and every build makes one before its
 * first chunk: the preflight probe warns when its worker ends without
 * `chunk_report` (src/auto-build/loop/preflight.ts).
 *
 * Cases: eval/worker-report/cases.json (generic, public), plus every *.json in
 * the private holdout's worker-report/ folder (eval/op-outcomes/private.mjs):
 * what real builds' workers ran into stays off a public repo. Results go to
 * that folder's results/, or are only printed when it does not exist.
 *
 * It talks to no LAX server. Model calls go through classifySchema on the
 * provider LAX is set to (resolved from the data dir, read only), so it needs
 * that provider signed in. It costs one short call per case and repeat, two
 * when the first answer is refused.
 *
 *   npm run eval:worker-report -- [--model <id>] [--only <text>] [--repeat N] [--dry]
 *
 * --dry prints each case's packet and makes no model call.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { classifySchema } from "../../src/classifiers/schema-output.js";
import { chunkRoleBrief } from "../../src/auto-build/agents/chunk-runner.js";
import { chunkReportTool, readChunkReport } from "../../src/auto-build/agents/report-tools.js";
import type { ChunkReportCall } from "../../src/auto-build/agents/agent-report.js";
import { privateHoldoutDir } from "../op-outcomes/private.mjs";

/** What a right report holds. A field left out of a case is not scored. */
interface Expect {
  status?: ChunkReportCall["status"][];
  doneWhen?: ChunkReportCall["doneWhen"][];
  /** true: must name a refused command. false: must name none. */
  machineBlocked?: boolean;
  launchReadiness?: boolean;
  ownerQuestion?: boolean;
  specGaps?: boolean;
}

interface ReportCase {
  id: string;
  source: string;
  chunk: { number: number; title: string; slice: string; doneWhen: string };
  /** What happened in the run, as the worker saw it. */
  happened: string;
  expect: Expect;
  why: string;
}

type Verdict = "right" | "wrong" | "refused" | "no-answer";
interface Row { id: string; run: number; verdict: Verdict; detail: string; report?: ChunkReportCall }

const HERE = resolve(import.meta.dirname);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadCases(): ReportCase[] {
  const files = [join(HERE, "cases.json")];
  const priv = join(privateHoldoutDir() as string, "worker-report");
  if (existsSync(priv)) files.push(...readdirSync(priv).filter((f) => f.endsWith(".json")).map((f) => join(priv, f)));
  return files.flatMap((f) => JSON.parse(readFileSync(f, "utf-8")) as ReportCase[]);
}

/** The worker's brief and the tool as the model is given them in a build. */
function systemPrompt(): string {
  return (
    `${chunkRoleBrief("chunk-runner-trunk")}\n\n` +
    `## The chunk_report tool\n\n${chunkReportTool.description}\n\n` +
    `Its arguments (JSON schema):\n${JSON.stringify(chunkReportTool.parameters, null, 1)}`
  );
}

function userPrompt(c: ReportCase, refusal?: string): string {
  return (
    `## Your chunk\n\nChunk ${c.chunk.number}: ${c.chunk.title}\nSlice: ${c.chunk.slice}\nDone when: ${c.chunk.doneWhen}\n\n` +
    `## What happened in your run\n\n${c.happened}\n\n` +
    `Your run ends here. Answer with the arguments you pass to chunk_report, as JSON.` +
    (refusal ? `\n\nYour first call was refused by the tool: ${refusal}` : "")
  );
}

const answerSchema = z.object({ status: z.string(), done_when: z.string() }).passthrough();
const SHAPE = `{"status":"...","done_when":"...","note":"...", and each optional argument only when it applies}`;

async function ask(c: ReportCase, model: string | undefined, refusal?: string): Promise<Record<string, unknown> | null> {
  const raw = await classifySchema({
    category: "worker-report-eval",
    systemPrompt: systemPrompt(),
    userPrompt: userPrompt(c, refusal),
    schema: answerSchema,
    shapeHint: SHAPE,
    role: "review",
    timeoutMs: 180_000,
    maxResponseChars: 8_000,
    ...(model ? { model } : {}),
  });
  return raw as Record<string, unknown> | null;
}

/** Each expectation the report misses, in words. Empty when it is right. */
export function missed(expect: Expect, r: ChunkReportCall): string[] {
  const out: string[] = [];
  if (expect.status && !expect.status.includes(r.status)) out.push(`status ${r.status} (right: ${expect.status.join("/")})`);
  if (expect.doneWhen && !expect.doneWhen.includes(r.doneWhen)) out.push(`done_when ${r.doneWhen} (right: ${expect.doneWhen.join("/")})`);
  const has = (wanted: boolean | undefined, present: boolean, field: string) => {
    if (wanted === undefined || wanted === present) return;
    out.push(wanted ? `${field} is empty` : `${field} is filled in with nothing to put there`);
  };
  has(expect.machineBlocked, r.machineBlocked.length > 0, "machine_blocked");
  has(expect.launchReadiness, r.launchReadiness.length > 0, "launch_readiness");
  has(expect.ownerQuestion, r.ownerQuestion !== "", "owner_question");
  has(expect.specGaps, r.specGaps !== "", "spec_gaps");
  return out;
}

async function runCase(c: ReportCase, run: number, model: string | undefined): Promise<Row> {
  let args = await ask(c, model);
  if (!args) return { id: c.id, run, verdict: "no-answer", detail: "no answer from the model" };
  let report = readChunkReport(args);
  if ("error" in report) {
    args = await ask(c, model, report.error);
    if (!args) return { id: c.id, run, verdict: "no-answer", detail: "no answer after the tool refused the first" };
    report = readChunkReport(args);
    if ("error" in report) return { id: c.id, run, verdict: "refused", detail: `refused twice: ${report.error}` };
  }
  const gaps = missed(c.expect, report);
  return { id: c.id, run, verdict: gaps.length ? "wrong" : "right", detail: gaps.join("; "), report };
}

async function main(): Promise<void> {
  const model = arg("model");
  const only = arg("only");
  const repeat = Number(arg("repeat") ?? 1);
  const cases = loadCases().filter((c) => !only || c.id.includes(only));
  if (process.argv.includes("--dry")) {
    console.log(systemPrompt());
    for (const c of cases) console.log(`\n───── ${c.id} ─────\n${userPrompt(c)}\n\nexpect: ${JSON.stringify(c.expect)}`);
    // The worker's brief comes from the agent runner, whose imports keep the
    // process alive: exit, as every other path here does.
    process.exit(0);
  }
  console.log(`${cases.length} case(s), ${repeat} answer(s) each${model ? `, model ${model}` : ""}\n`);
  const rows: Row[] = [];
  const queue = cases.flatMap((c) => Array.from({ length: repeat }, (_, run) => ({ c, run })));
  const workers = Array.from({ length: 4 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const row = await runCase(job.c, job.run, model);
      rows.push(row);
      console.log(`${row.verdict.padEnd(9)} ${row.id}${repeat > 1 ? ` #${row.run + 1}` : ""}${row.detail ? `: ${row.detail}` : ""}`);
    }
  });
  await Promise.all(workers);

  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n${rows.length} reports: ${count("right")} right, ${count("wrong")} wrong, ${count("refused")} refused twice, ${count("no-answer")} no answer`);
  for (const r of rows.filter((x) => x.verdict === "wrong")) {
    const c = cases.find((x) => x.id === r.id)!;
    console.log(`\nWRONG ${r.id}: ${r.detail}\n  Why it matters: ${c.why}\n  The report's note: ${r.report?.note.slice(0, 300)}`);
  }

  const priv = join(privateHoldoutDir() as string, "worker-report");
  if (rows.length && existsSync(priv)) {
    const dir = join(priv, "results");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${model ?? "default"}.json`);
    writeFileSync(file, JSON.stringify({ model: model ?? "default", repeat, rows }, null, 1));
    console.log(`\nResults: ${file}`);
  }
  process.exit(rows.length - count("right") > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE, "run.ts")) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
