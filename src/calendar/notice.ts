// After a chat turn, on any channel: plans the exchange settled are recorded
// (plans.ts), and one that overlaps another commitment is raised as a clash
// in the inbox, which rings the phone. Called from memory/manager.ts
// persistTurn, which every channel's turn reaches.
//
// A turn that read outside content (a web page, a mail) may only record what
// the user's own words say: a plan the reply took from that content could be
// planted there.

import { extractPlansWithLLM, type ExtractedPlan } from "../classifiers/plan-extract.js";
import { inboxPlanClash } from "../inbox/producers.js";
import { isSyntheticSessionId } from "../memory/synthetic-sessions.js";
import { createLogger } from "../logger.js";
import { describeEvent, recordPlan, type NoticedPlan, type PlanResult } from "./plans.js";
import type { PlanOrigin } from "./types.js";

const logger = createLogger("calendar.notice");

export interface NoticeDeps {
  now?: () => Date;
  extract?: typeof extractPlansWithLLM;
  record?: (plan: NoticedPlan) => Promise<PlanResult>;
  announce?: typeof announceClash;
}

/** Tell the user a plan overlaps another commitment. */
export function announceClash(plan: { title: string; start: string }, clashes: PlanResult["clashes"], origin: Omit<PlanOrigin, "at">): void {
  const others = clashes.slice(0, 3).map((c) => describeEvent(c)).join("; ");
  inboxPlanClash({
    key: `clash:${origin.kind}:${origin.ref}:${Date.parse(plan.start)}`,
    title: `Heads up: ${describeEvent(plan)} overlaps another plan`,
    body: `${describeEvent(plan)} is at the same time as ${others}. Reply here to sort it out.`,
  });
}

export async function noticePlansInTurn(
  input: { userMessage: string; assistantResponse: string; sessionId: string; hasExternalTaint?: boolean },
  deps: NoticeDeps = {},
): Promise<number> {
  if (!input.sessionId || isSyntheticSessionId(input.sessionId)) return 0;
  const now = (deps.now ?? (() => new Date()))();
  let plans: ExtractedPlan[];
  try {
    plans = await (deps.extract ?? extractPlansWithLLM)({ userMessage: input.userMessage, assistantResponse: input.assistantResponse, now });
  } catch (e) {
    logger.warn(`[plans] extraction failed: ${(e as Error).message}`);
    return 0;
  }
  if (input.hasExternalTaint) plans = plans.filter((p) => input.userMessage.includes(p.evidence));
  let clashes = 0;
  for (const p of plans) {
    const origin = { kind: "chat" as const, ref: input.sessionId };
    const plan: NoticedPlan = { title: p.what, start: p.start, ...(p.end ? { end: p.end } : {}), ...(p.where ? { where: p.where } : {}), ...(p.who ? { who: p.who } : {}), origin };
    try {
      const r = await (deps.record ?? ((x: NoticedPlan) => recordPlan(x, { now: () => now })))(plan);
      if (r.recorded && r.clashes.length > 0) {
        (deps.announce ?? announceClash)(plan, r.clashes, origin);
        clashes++;
      }
    } catch (e) {
      logger.warn(`[plans] "${p.what}" not recorded: ${(e as Error).message}`);
    }
  }
  return clashes;
}
