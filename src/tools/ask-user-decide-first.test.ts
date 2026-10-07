// A model that asks before doing anything hands the work back unstarted ("what
// style should the deck be?" instead of a deck in a sensible style); GPT-class
// models do it constantly. The first ask of a request that has built nothing is
// answered with "decide and do it" and NOT delivered, so the turn keeps going;
// a second ask is delivered, for the questions only the user can answer.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { turns } = vi.hoisted(() => ({ turns: { rows: [] as unknown[] } }));
vi.mock("../canonical-loop/public/op-facts.js", async (o) => ({ ...(await o<typeof import("../canonical-loop/public/op-facts.js")>()), readOpTurns: () => turns.rows }));

import { askUserTool } from "./ask-user-tool.js";

const WROTE = [{ toolCallSummary: [{ tool: "write", resultStatus: "ok", committing: true }] }];
let op = 0;
const ask = (opId: string) => askUserTool.execute({ question: "What style should the deck use?", _operationId: opId });

beforeEach(() => { turns.rows = []; });

describe("ask_user before any work", () => {
  it("is not delivered the first time: the model is told to decide and build", async () => {
    const r = await ask(`op-decide-${++op}`);
    expect(r.status).toBe("blocked");
    expect(r.metadata?.recovery).toMatch(/Decide what you can.*do the work/);
    expect(r.metadata?.recovery).toMatch(/call ask_user again/);
  });

  it("is delivered when asked again (only the user can answer)", async () => {
    const id = `op-decide-${++op}`;
    await ask(id);
    const again = await ask(id);
    expect(again.status).not.toBe("blocked");
    expect(again.content).toMatch(/Question delivered/);
  });

  it("is delivered at once after real work", async () => {
    turns.rows = WROTE;
    expect((await ask(`op-decide-${++op}`)).content).toMatch(/Question delivered/);
  });

  it("is delivered at once outside a request (no op)", async () => {
    expect((await askUserTool.execute({ question: "Which account?" })).content).toMatch(/Question delivered/);
  });

  it("does not count the task list as work", async () => {
    turns.rows = [{ toolCallSummary: [{ tool: "task_create", resultStatus: "ok", committing: true }] }];
    expect((await ask(`op-decide-${++op}`)).status).toBe("blocked");
  });
});
