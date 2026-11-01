import { describe, it, expect } from "vitest";
import { appendOpMessage, opRequestText } from "./store.js";
import type { OpMessageRow } from "./types.js";

let n = 0;
const freshOpId = (): string => `op_request_text_${n++}_${process.pid}`;

function row(opId: string, turnIdx: number, seqInTurn: number, role: OpMessageRow["role"], content: unknown): void {
  appendOpMessage({ messageId: `${opId}-${turnIdx}-${seqInTurn}`, opId, turnIdx, seqInTurn, role, content, createdAt: new Date(0).toISOString() } as OpMessageRow);
}

describe("opRequestText", () => {
  it("is the chat's current message, not its oldest one, when the op is seeded with history", () => {
    const op = freshOpId();
    row(op, 0, 0, "user", { text: "can you build a game using unreal engine" });
    row(op, 0, 1, "assistant", { text: "Unreal is not installed." });
    row(op, 0, 2, "user", { text: "i guess we can go 3js" });
    row(op, 0, 3, "assistant", { text: "Built it." });
    row(op, 0, 4, "user", { text: "Recalled memory for the user's message above", kind: "recall" });
    row(op, 0, 5, "user", { text: "keep iterating for 2 hours on the look and feel" });
    row(op, 2, 0, "user", { text: "SYSTEM: you are 25% through this task's iteration budget.", kind: "nudge" });

    expect(opRequestText(op)).toBe("keep iterating for 2 hours on the look and feel");
  });

  it("skips a harness row seeded after the request", () => {
    const op = freshOpId();
    row(op, 0, 0, "user", { text: "write the plan to /app/plan.jsonl" });
    row(op, 0, 1, "user", { text: "Recalled memory", kind: "recall" });
    expect(opRequestText(op)).toBe("write the plan to /app/plan.jsonl");
  });

  it("is a delegated op's only turn-0 message, and empty when there is none", () => {
    const op = freshOpId();
    row(op, 0, 0, "user", "Fix the failing test in src/a.ts");
    expect(opRequestText(op)).toBe("Fix the failing test in src/a.ts");
    expect(opRequestText(freshOpId())).toBe("");
  });
});
