// A Stop can land inside any completion gate's await (build-verify runs a real
// build). The gates after it spawn git and call a model, so the chain hands
// every gate one signal that the op's cancel aborts; a Stop must never wait on
// a gate's spawn or model call.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../../ops/types.js";

const h = vi.hoisted(() => ({
  seen: [] as Array<{ name: string; aborted: boolean }>,
  during: undefined as undefined | (() => void),
  persisted: null as null | { canonical: { state?: string; cancelRequestedAt?: string | null } },
}));

vi.mock("./decide-outcome-gates.js", () => ({
  COMPLETION_GATES: ["first", "second"].map((name) => ({
    name,
    async evaluate(ctx: { signal?: AbortSignal }) {
      if (name === "first") h.during?.();
      h.seen.push({ name, aborted: ctx.signal?.aborted ?? false });
      return { reopen: false };
    },
  })),
}));
vi.mock("../../ops/op-store.js", () => ({ readOp: () => h.persisted }));

import { runCompletionGates } from "./decide-outcome-run-gates.js";
import { publishSignal } from "../signals.js";

const op = { id: "op-run-gates" } as Op;
const ctx = { op, turnIdx: 0, toolCalls: [], assistantText: "" };

afterEach(() => {
  h.seen.length = 0;
  h.during = undefined;
  h.persisted = null;
});

describe("runCompletionGates — the cancel signal every gate gets", () => {
  it("is live while nothing cancels", async () => {
    await runCompletionGates(ctx, "done", false, []);
    expect(h.seen).toEqual([{ name: "first", aborted: false }, { name: "second", aborted: false }]);
  });

  it("aborts for the later gates when a Stop lands inside an earlier gate", async () => {
    h.during = () => publishSignal({ kind: "cancel", opId: op.id, actor: "user", ts: new Date().toISOString() });
    await runCompletionGates(ctx, "done", false, []);
    expect(h.seen).toEqual([{ name: "first", aborted: true }, { name: "second", aborted: true }]);
  });

  it("starts aborted when the Stop was recorded before the chain began", async () => {
    h.persisted = { canonical: { state: "running", cancelRequestedAt: new Date().toISOString() } };
    await runCompletionGates(ctx, "done", false, []);
    expect(h.seen.every((s) => s.aborted)).toBe(true);
    h.seen.length = 0;
    h.persisted = { canonical: { state: "cancelling" } };
    await runCompletionGates(ctx, "done", false, []);
    expect(h.seen.every((s) => s.aborted)).toBe(true);
  });

  it("ignores another op's cancel", async () => {
    h.during = () => publishSignal({ kind: "cancel", opId: "another-op", actor: "user", ts: new Date().toISOString() });
    await runCompletionGates(ctx, "done", false, []);
    expect(h.seen.some((s) => s.aborted)).toBe(false);
  });
});
