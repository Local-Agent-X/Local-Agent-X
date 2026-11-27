/**
 * What a run was and why it ran, read from its op record: a chat turn you typed,
 * a build decision the engine posted to the lead, a builder or reviewer the build
 * engine launched, a background job. The Usage tab groups cost by this, so a
 * build's 58 worker runs show as so many builds, reviews and finish fixes
 * (2026-11-27) instead of one undifferentiated pile.
 *
 * Read from the op's type and the opening of its task, as each launcher writes
 * it (auto-build/advisor/lead-decisions.ts, chunk-review's skeptic, the finish
 * gates). A task that matches nothing keeps the op type as its reason.
 */
import type { Op } from "../ops/types.js";
import { APP_MESSAGE_LEAD } from "../harness-text.js";
import { OP_TYPE } from "../ops/op-types.js";

export type RunKind = "chat" | "worker" | "background";

export interface RunKindInfo {
  kind: RunKind;
  /** Why it ran, in a few words: "you typed", "build decision", "review", … */
  reason: string;
  /** What it was about: the task's first line, shortened. */
  title: string;
  /** The project a worker worked in, by folder name. */
  project?: string;
}

const TITLE_CHARS = 90;

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line;
}

function chatReason(task: string): { reason: string; title: string } {
  if (!task.startsWith(APP_MESSAGE_LEAD)) return { reason: "you typed", title: firstLine(task) };
  // "(Sent by the app, not typed by the user: a build decision is waiting.)"
  const what = /^\(Sent by the app, not typed by the user:\s*([^)]*)\)/.exec(task)?.[1] ?? "";
  const headline = task.split("\n").find((l) => /^Decision \S+:/.test(l)) ?? "";
  if (/build decision/i.test(what)) return { reason: "build decision", title: firstLine(headline.replace(/^Decision \S+:\s*/, "")) || what };
  if (/background work/i.test(what)) return { reason: "background work ended", title: firstLine(task.slice(task.indexOf(")") + 1)) };
  return { reason: "app message", title: what || firstLine(task) };
}

function workerReason(task: string): string {
  const head = task.slice(0, 200);
  if (/^Skeptic:/i.test(head)) return /Finish fix \d+/i.test(head) ? "finish-fix review" : "review";
  if (/^Finish fix \d+/i.test(head) || /\bFinish fix \d+:/.test(head)) return "finish fix";
  if (/^(Auditor|Finish check)/i.test(head)) return "finish check";
  if (/fix round/i.test(head)) return "fix round";
  return "build chunk";
}

const humanType = (type: string): string => type.replace(/_/g, " ");

export function runKindOf(op: Pick<Op, "type" | "task"> & { contextPack?: Op["contextPack"] }): RunKindInfo {
  const task = typeof op.task === "string" ? op.task : "";
  if (op.type === OP_TYPE.chatTurn || op.type === OP_TYPE.voiceTurn) {
    const { reason, title } = chatReason(task);
    return { kind: "chat", reason: op.type === OP_TYPE.voiceTurn ? `voice: ${reason}` : reason, title };
  }
  if (op.type === OP_TYPE.agentSpawn) {
    const workRoot = (op.contextPack?.routing as { workRoot?: unknown } | undefined)?.workRoot;
    const project = typeof workRoot === "string" ? workRoot.split(/[\\/]/).filter(Boolean).pop() : undefined;
    return { kind: "worker", reason: workerReason(task), title: firstLine(task.replace(/^Skeptic:\s*/i, "")), ...(project ? { project } : {}) };
  }
  return { kind: "background", reason: humanType(op.type), title: firstLine(task) };
}
