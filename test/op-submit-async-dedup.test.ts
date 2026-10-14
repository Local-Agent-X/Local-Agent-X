/**
 * op_submit_async dedups on the SUBMISSION'S CONTENT, not on time-per-session.
 *
 * The description promises "submit a second time with the same task in the
 * same turn and you get the existing opId back". The old secondary guard
 * instead refused ANY submission within 30s of the previous one in the same
 * session, so parallel fan-out ("research X" then "build Y") hit BLOCKED on
 * the second call, while the same-task case got a BLOCKED lecture rather than
 * the existing opId.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

vi.mock("../src/ops/tools/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ops/tools/shared.js")>();
  return {
    ...actual,
    async configureDelegatedRuntime(op: Op) {
      const { registerAdapterForOp } = await import("../src/canonical-loop/runtime.js");
      op.model = "dedup-test-model";
      registerAdapterForOp(op.id, () => ({
        name: "dedup-test",
        version: "1",
        async runTurn() {
          return {
            providerState: { adapterName: "dedup-test", adapterVersion: "1", providerPayload: null },
            terminalReason: "done" as const,
          };
        },
        async abort() {},
      }));
    },
  };
});

const { opSubmitAsyncTool } = await import("../src/ops/tools.js");
const { RECENT_SUBMITS, recentDuplicateSubmit, recordRecentSubmit } = await import("../src/ops/tools/shared.js");
import type { Op } from "../src/ops/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const spawned = new Set<string>();

afterEach(() => {
  for (const id of spawned) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  spawned.clear();
});

const opIdOf = (content: string): string => /op (op_[a-z0-9_]+) /.exec(content)?.[1] ?? "";

describe("recentDuplicateSubmit", () => {
  afterEach(() => RECENT_SUBMITS.clear());

  it("matches a verbatim or rephrased repeat from the same session, not a different task or session", () => {
    recordRecentSubmit("s1", "op_a", "Research  the competitor pricing pages");
    expect(recentDuplicateSubmit("s1", "research the competitor pricing pages")?.opId).toBe("op_a");
    expect(recentDuplicateSubmit("s1", "Please research the competitor pricing pages for me")?.opId).toBe("op_a");
    expect(recentDuplicateSubmit("s1", "draft the launch announcement email")).toBeUndefined();
    expect(recentDuplicateSubmit("s2", "research the competitor pricing pages")).toBeUndefined();
  });

  it("forgets a submission once the window has passed", () => {
    RECENT_SUBMITS.set("s1", [{ opId: "op_old", ts: Date.now() - 31_000, task: "research the competitor pricing pages" }]);
    expect(recentDuplicateSubmit("s1", "research the competitor pricing pages")).toBeUndefined();
    expect(RECENT_SUBMITS.has("s1")).toBe(false);
  });
});

describe("op_submit_async same-task dedup", () => {
  it("lets a DIFFERENT task through right after a submit, and hands the existing opId back for the SAME one", async () => {
    const sessionId = `chat-dedup-${Date.now().toString(36)}`;

    const first = await opSubmitAsyncTool.execute({ task: "research the competitor pricing pages", lane: "interactive", _sessionId: sessionId });
    expect(first.content).toMatch(/submitted|queued/);
    const firstId = opIdOf(first.content);
    expect(firstId).not.toBe("");
    spawned.add(firstId);

    const other = await opSubmitAsyncTool.execute({ task: "draft the launch announcement email", lane: "interactive", _sessionId: sessionId });
    expect(other.content).not.toMatch(/^BLOCKED/);
    expect(other.content).toMatch(/submitted|queued/);
    spawned.add(opIdOf(other.content));

    const again = await opSubmitAsyncTool.execute({ task: "Research the competitor pricing pages", lane: "interactive", _sessionId: sessionId });
    expect(opIdOf(again.content)).toBe(firstId);
    expect(again.content).toMatch(/already submitted/);
    expect(again.content).not.toMatch(/^BLOCKED/);

    const rephrased = await opSubmitAsyncTool.execute({ task: "Go research the competitor pricing pages now", lane: "interactive", _sessionId: sessionId });
    expect(opIdOf(rephrased.content)).toBe(firstId);
  });
});
