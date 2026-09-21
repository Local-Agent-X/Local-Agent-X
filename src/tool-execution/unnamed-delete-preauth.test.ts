/**
 * ONE card per turn, asked before anything dispatches.
 *
 * Approvals are requested per tool call and a model that wipes a folder emits
 * its deletes in one assistant turn, so without the batch pre-pass the user
 * answers the same question five times. Also pinned: every way this floor is
 * supposed to stay OUT of the way.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-unnamed-preauth-"));

const requests: Array<{ context: string; args: unknown; alwaysAsk?: boolean }> = [];
let answer: { approved: boolean; reason?: string } = { approved: false, reason: "declined" };
vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({
    requestApprovalDetailed: async (o: { context: string; args: unknown; alwaysAsk?: boolean }) => { requests.push(o); return answer; },
  }),
}));

const { preauthorizeUnnamedDeletes } = await import("./unnamed-delete-preauth.js");
const { takeUnnamedDeleteDecision } = await import("./unnamed-delete-gate.js");

const VAGUE: ChatCompletionMessageParam[] = [{ role: "user", content: "The client-data folder is getting messy. Just clear it out." }];
const wipe = ["originals/signed-contract-2026.md", "originals/invoice-0042.md", "originals/handover-notes.md", "tmp/export-scratch.tmp", "tmp/thumbnail-cache.tmp"]
  .map((p, i) => ({ id: `t${i}`, name: "delete_file", arguments: JSON.stringify({ path: `workspace/client-data/${p}` }) }));
const base = { toolCalls: wipe, priorMessages: VAGUE, modelId: "qwen3.6:27b", callContext: "local", sessionId: "s", onEvent: () => {} };

beforeEach(() => { requests.length = 0; answer = { approved: false, reason: "declined" }; });

describe("the un-named delete pre-pass", () => {
  it("asks ONCE for five deletes, and the card lists all five files", async () => {
    await preauthorizeUnnamedDeletes(base);
    expect(requests).toHaveLength(1);
    for (const c of wipe) expect(requests[0].context).toContain(JSON.parse(c.arguments).path);
    expect(requests[0].alwaysAsk, "a session 'always allow' must never cover a different set of files").toBe(true);
  });

  it("a decline stops every one of them", async () => {
    await preauthorizeUnnamedDeletes(base);
    for (const c of wipe) expect(takeUnnamedDeleteDecision(c.id)).toEqual({ approved: false, reason: "declined" });
  });

  it("an approval covers every one of them", async () => {
    answer = { approved: true };
    await preauthorizeUnnamedDeletes(base);
    for (const c of wipe) expect(takeUnnamedDeleteDecision(c.id)).toEqual({ approved: true });
  });

  it("stays out of the way: a named file, a frontier model, an unattended run", async () => {
    const named = [{ id: "n1", name: "delete_file", arguments: '{"path":"client-data/tmp/thumbnail-cache.tmp"}' }];
    const clear: ChatCompletionMessageParam[] = [{ role: "user", content: "Delete exactly one file: client-data/tmp/thumbnail-cache.tmp." }];
    await preauthorizeUnnamedDeletes({ ...base, toolCalls: named, priorMessages: clear });
    await preauthorizeUnnamedDeletes({ ...base, modelId: "claude-opus-4-8" });
    await preauthorizeUnnamedDeletes({ ...base, modelId: undefined });
    await preauthorizeUnnamedDeletes({ ...base, callContext: "cron" });
    expect(requests, "a card was raised where the floor does not apply").toHaveLength(0);
    expect(takeUnnamedDeleteDecision("t0")).toBeUndefined();
  });

  it("with no way to show a card it refuses, rather than letting the call confirm itself", async () => {
    await preauthorizeUnnamedDeletes({ ...base, onEvent: undefined });
    expect(requests).toHaveLength(0);
    expect(takeUnnamedDeleteDecision("t0")).toEqual({ approved: false, reason: undefined });
  });
});
