/**
 * ONE card per turn, asked before anything dispatches.
 *
 * Approvals are requested per tool call and a model that wipes a folder emits
 * its deletes in one assistant turn, so without the batch pre-pass the user
 * answers the same question five times. Also pinned: every way this floor is
 * supposed to stay OUT of the way.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// A folder delete_file removes goes to the trash whole (Peter, 2026-09-25) — and
// always asks, even when the user named it, because "clean up client-data"
// names the very folder it must not remove. Unattended, it is refused.
describe("folder deletes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lax-preauth-folder-"));
  mkdirSync(join(dir, "build-cache", "chunks"), { recursive: true });
  writeFileSync(join(dir, "build-cache", "chunks", "a.js"), "");
  writeFileSync(join(dir, "build-cache", "manifest.json"), "");
  const folder = join(dir, "build-cache");
  const call = [{ id: "f1", name: "delete_file", arguments: JSON.stringify({ path: folder }) }];
  const named: ChatCompletionMessageParam[] = [{ role: "user", content: `Remove the ${folder} folder, all of it.` }];

  it("a folder the user NAMED still gets one card, listing it as a folder with its file count", async () => {
    await preauthorizeUnnamedDeletes({ ...base, toolCalls: call, priorMessages: named });
    expect(requests).toHaveLength(1);
    expect(requests[0].context).toContain("(folder, 2 files)");
    expect(requests[0].context).toContain("even when you named it");
    expect(takeUnnamedDeleteDecision("f1")).toEqual({ approved: false, reason: "declined" });
  });

  it("with no one to answer (unattended, or no model id), a folder delete is refused and a file delete is left as before", async () => {
    const file = { id: "x1", name: "delete_file", arguments: JSON.stringify({ path: "workspace/client-data/tmp/export-scratch.tmp" }) };
    await preauthorizeUnnamedDeletes({ ...base, toolCalls: [...call, file], callContext: "cron" });
    expect(requests).toHaveLength(0);
    expect(takeUnnamedDeleteDecision("f1")).toEqual({ approved: false, reason: undefined });
    expect(takeUnnamedDeleteDecision("x1")).toBeUndefined();
    await preauthorizeUnnamedDeletes({ ...base, toolCalls: call, modelId: undefined });
    expect(takeUnnamedDeleteDecision("f1")).toEqual({ approved: false, reason: undefined });
  });
});

describe("the un-named delete pre-pass", () => {
  it("a shell command deleting five un-named files gets ONE card listing all five, and a decline stops the call", async () => {
    const shell = [{ id: "sh1", name: "bash", arguments: JSON.stringify({ command: wipe.map((c) => `rm ${JSON.parse(c.arguments).path}`).join(" && ") }) }];
    await preauthorizeUnnamedDeletes({ ...base, toolCalls: shell });
    expect(requests).toHaveLength(1);
    for (const c of wipe) expect(requests[0].context).toContain(JSON.parse(c.arguments).path);
    expect(takeUnnamedDeleteDecision("sh1")).toEqual({ approved: false, reason: "declined" });
  });

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

  it("stays out of the way: a named file, no model id, an unattended run", async () => {
    const named = [{ id: "n1", name: "delete_file", arguments: '{"path":"client-data/tmp/thumbnail-cache.tmp"}' }];
    const clear: ChatCompletionMessageParam[] = [{ role: "user", content: "Delete exactly one file: client-data/tmp/thumbnail-cache.tmp." }];
    await preauthorizeUnnamedDeletes({ ...base, toolCalls: named, priorMessages: clear });
    await preauthorizeUnnamedDeletes({ ...base, modelId: undefined });
    await preauthorizeUnnamedDeletes({ ...base, callContext: "cron" });
    expect(requests, "a card was raised where the floor does not apply").toHaveLength(0);
    expect(takeUnnamedDeleteDecision("t0")).toBeUndefined();
  });

  // Until 2026-09-25 a frontier model was exempt; gpt-5.6 then deleted three
  // un-named client originals uncarded on the vague-wipe case. One card, same
  // as the local tiers.
  it("a frontier model gets the same one card for un-named deletes", async () => {
    await preauthorizeUnnamedDeletes({ ...base, modelId: "gpt-5.6-sol" });
    expect(requests).toHaveLength(1);
    for (const c of wipe) expect(takeUnnamedDeleteDecision(c.id)).toEqual({ approved: false, reason: "declined" });
  });

  it("with no way to show a card it refuses, rather than letting the call confirm itself", async () => {
    await preauthorizeUnnamedDeletes({ ...base, onEvent: undefined });
    expect(requests).toHaveLength(0);
    expect(takeUnnamedDeleteDecision("t0")).toEqual({ approved: false, reason: undefined });
  });
});

// Lane 1 (2026-09-26): a file the agent itself created this session, with one of
// its file tools, is its scratch — deleting it asks nothing. The card Peter hit
// was for ns_tmp.json / ns_tmp.txt, the agent's own parse output. The exemption
// ends where it could be abused: a session that read untrusted content, or more
// than OWN_FILE_DELETES_PER_TURN of them in one turn.
describe("the agent's own files", async () => {
  const { recordTaskArtifact, clearTaskArtifacts } = await import("../data-lineage/task-artifacts.js");
  const { recordExternalIngestion, clearExternalIngestion } = await import("../data-lineage/external.js");
  const { OWN_FILE_DELETES_PER_TURN } = await import("./unnamed-delete-gate.js");
  const dir = mkdtempSync(join(tmpdir(), "lax-preauth-own-"));
  const own = (name: string) => { const p = join(dir, name); writeFileSync(p, "{}"); recordTaskArtifact("own", p); return p; };
  const del = (id: string, path: string) => ({ id, name: "delete_file", arguments: JSON.stringify({ path }) });
  const cleanUp: ChatCompletionMessageParam[] = [{ role: "user", content: "Clean up the temporary files." }];
  const scope = { ...base, sessionId: "own", priorMessages: cleanUp };

  beforeEach(() => { clearTaskArtifacts("own"); clearExternalIngestion("own"); });

  it("deletes its own scratch with no card", async () => {
    await preauthorizeUnnamedDeletes({ ...scope, toolCalls: [del("o1", own("ns_tmp.json")), del("o2", own("ns_tmp.txt"))] });
    expect(requests).toHaveLength(0);
    expect(takeUnnamedDeleteDecision("o1")).toBeUndefined();
    expect(takeUnnamedDeleteDecision("o2")).toBeUndefined();
  });

  it("a file it did not create still asks, and the card lists only that one", async () => {
    const theirs = join(dir, "handover-notes.md"); writeFileSync(theirs, "notes");
    await preauthorizeUnnamedDeletes({ ...scope, toolCalls: [del("o3", own("scratch.json")), del("o4", theirs)] });
    expect(requests).toHaveLength(1);
    expect(requests[0].context).toContain("handover-notes.md");
    expect(requests[0].context).not.toContain("scratch.json");
    expect(takeUnnamedDeleteDecision("o3")).toBeUndefined();
  });

  it("after the session read untrusted content, its own files ask too", async () => {
    recordExternalIngestion("own");
    await preauthorizeUnnamedDeletes({ ...scope, toolCalls: [del("o5", own("page-dump.json"))] });
    expect(requests).toHaveLength(1);
    expect(takeUnnamedDeleteDecision("o5")).toEqual({ approved: false, reason: "declined" });
  });

  it(`more than ${OWN_FILE_DELETES_PER_TURN} in one turn: one card for all of them`, async () => {
    const calls = Array.from({ length: OWN_FILE_DELETES_PER_TURN + 1 }, (_, i) => del(`m${i}`, own(`part-${i}.json`)));
    await preauthorizeUnnamedDeletes({ ...scope, toolCalls: calls });
    expect(requests).toHaveLength(1);
    expect(requests[0].context).toContain(`${OWN_FILE_DELETES_PER_TURN + 1} files`);
  });

  it("a shell rm of its own scratch asks nothing either", async () => {
    const p = own("tmp-out.txt");
    await preauthorizeUnnamedDeletes({ ...scope, toolCalls: [{ id: "o6", name: "bash", arguments: JSON.stringify({ command: `rm "${p}"` }) }] });
    expect(requests).toHaveLength(0);
  });
});
