import { describe, it, expect } from "vitest";
import {
  isCommittingTool,
  opCommittedWork,
  opCommittedSubstantiveWork,
  detectCommittingCalls,
} from "./committing-tool-check.js";

const turns = (...tools: Array<[string, string]>) => [
  { toolCallSummary: tools.map(([tool, resultStatus]) => ({ tool, resultStatus })) },
];

const pdfCall = (action: string) => [{
  role: "assistant" as const,
  tool_calls: [{
    id: "1", type: "function" as const,
    function: { name: "pdf", arguments: JSON.stringify({ action, file_path: "a.pdf" }) },
  }],
}] as never;

describe("op-level committing predicates", () => {
  it("both ignore tool calls that did not succeed", () => {
    const failed = turns(["write", "error"]);
    expect(opCommittedWork(failed)).toBe(false);
    expect(opCommittedSubstantiveWork(failed)).toBe(false);
  });

  it("both credit a real write", () => {
    const wrote = turns(["write", "ok"]);
    expect(opCommittedWork(wrote)).toBe(true);
    expect(opCommittedSubstantiveWork(wrote)).toBe(true);
  });

  it("diverge on the task ledger: committing for replay, not progress for gating", () => {
    const planned = turns(["task_create", "ok"], ["task_update", "ok"]);
    expect(opCommittedWork(planned)).toBe(true);
    expect(opCommittedSubstantiveWork(planned)).toBe(false);
  });

  it("finds the write when planning precedes it", () => {
    expect(opCommittedSubstantiveWork(turns(["task_create", "ok"], ["edit", "ok"]))).toBe(true);
  });

  it("treats an empty op as no work", () => {
    expect(opCommittedWork([])).toBe(false);
    expect(opCommittedSubstantiveWork([])).toBe(false);
  });
});

describe("pdf is judged by its action, not its risk class", () => {
  it("is not committing on the name-only layer", () => {
    expect(isCommittingTool("pdf")).toBe(false);
  });

  it("reading documents is not substantive work", () => {
    expect(opCommittedSubstantiveWork(turns(["pdf", "ok"], ["task_create", "ok"]))).toBe(false);
  });

  it("still suppresses failover when it writes a file", () => {
    expect(detectCommittingCalls(pdfCall("create"))).toHaveLength(1);
    expect(detectCommittingCalls(pdfCall("merge"))).toHaveLength(1);
  });

  it("does not suppress failover for reads", () => {
    expect(detectCommittingCalls(pdfCall("read"))).toHaveLength(0);
    expect(detectCommittingCalls(pdfCall("extract_tables"))).toHaveLength(0);
  });

  it("treats an unknown action as committing", () => {
    expect(detectCommittingCalls(pdfCall(""))).toHaveLength(1);
  });
});
