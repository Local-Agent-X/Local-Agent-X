// Cross-seam contract: in a session with a registered work root, the path the
// file-access gate evaluates is the path the sink opens. The gate resolves a
// relative tool path with the call's session (<workRoot>/x); each sink below
// used to resolve the same argument without it (<workspace>/x), so the file it
// read, wrote, scanned, stat'd or deleted was one the gate never judged.
//
// Every resolution of a raw path goes through the canonical resolver, which is
// wrapped here to record what it returned. A kind passes when the gate and the
// sink each resolved the argument at least once and every answer is the work
// root's spelling. The harness checks are pinned by what they decide.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const { resolutions } = vi.hoisted(() => ({ resolutions: [] as Array<{ input: string; output: string }> }));
vi.mock("../src/workspace/paths.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/workspace/paths.js")>();
  const seen = (input: string, output: string) => { resolutions.push({ input, output }); return output; };
  return {
    ...real,
    resolveAgentPath: (p: string, sid?: string) => seen(p, real.resolveAgentPath(p, sid)),
    resolveAgentPathFrom: (ws: string, p: string, sid?: string) => seen(p, real.resolveAgentPathFrom(ws, p, sid)),
  };
});

import type { ToolDefinition } from "../src/types.js";
import { workspaceRoot } from "../src/config.js";
import { setSessionWorkRoot, clearSessionWorkRoot, sessionIdOf, sessionWorkRootOf, realpathDeep } from "../src/workspace/paths.js";
import { SecurityLayer } from "../src/security/layer/index.js";
import type { SecurityLayer as SecurityLayerType } from "../src/security/index.js";
import { collectRuntimeTools } from "../src/tools/runtime-tool-names.js";
import { createContext, type ToolCallContext } from "../src/tool-execution/context.js";
import { resolvePhase } from "../src/tool-execution/resolve-tool.js";
import { runSandboxedPhase } from "../src/tool-execution/run-sandboxed.js";
import { createTargetPath } from "../src/tool-execution/create-target-path.js";
import { readContentInView } from "../src/tool-execution/read-dedup-evidence.js";
import { unnamedDeletes } from "../src/tool-execution/unnamed-delete-gate.js";
import { announceNoticedDeletes } from "../src/tool-execution/unnamed-delete-preauth.js";
import { stillPresentAfterDelete } from "../src/tool-execution/verify-shell-deletes.js";
import { canonicalizeAttachmentPath, checkAttachmentPaths } from "../src/tools/http-egress-guard.js";
import { startSession, killSession, sleep, type ProcessSession } from "../src/tools/process-session.js";

const SESSION = "work-root-parity";
let workRoot: string;
let gate: SecurityLayer;
let tools: Map<string, ToolDefinition>;

beforeAll(async () => {
  workRoot = mkdtempSync(join(tmpdir(), "lax-parity-root-"));
  setSessionWorkRoot(SESSION, workRoot);
  gate = new SecurityLayer(workspaceRoot(), "unrestricted");
  tools = await collectRuntimeTools();
});
afterAll(() => {
  clearSessionWorkRoot(SESSION);
  rmSync(workRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const inWorkRoot = (raw: string) => resolve(sessionWorkRootOf(SESSION)!, raw);

/** The arguments the tool runs with: the resolve phase's trusted stamps applied. */
async function dispatched(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = createContext({
    tc: { id: `call-${name}`, name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: {} as SecurityLayerType,
    sessionId: SESSION,
    callContext: "local",
  });
  expect((await resolvePhase(ctx)).kind).toBe("continue");
  return ctx.args;
}

/** Every answer the canonical resolver gave for `raw` while `run` ran. */
async function resolvedDuring(raw: string, run: () => unknown): Promise<string[]> {
  resolutions.length = 0;
  try { await run(); } catch { /* a missing file is fine; the resolution already happened */ }
  return resolutions.filter((r) => r.input === raw).map((r) => r.output);
}

async function expectParity(tool: string, args: Record<string, unknown>, raw: string, sink: (stamped: Record<string, unknown>) => unknown) {
  const stamped = await dispatched(tool, args);
  const gated = await resolvedDuring(raw, () => gate.evaluate({ toolName: tool, args: stamped, sessionId: SESSION }));
  const opened = await resolvedDuring(raw, () => sink(stamped));
  expect(gated, `${tool}: the gate never resolved ${raw}`).not.toEqual([]);
  expect(opened, `${tool}: the sink never resolved ${raw}`).not.toEqual([]);
  expect(new Set([...gated, ...opened]), tool).toEqual(new Set([inWorkRoot(raw)]));
}

const run = (name: string) => (stamped: Record<string, unknown>) => tools.get(name)!.execute(stamped);

describe("work-rooted session: the gate and the sink resolve a relative path to the same file", () => {
  it("view_image", () => expectParity("view_image", { path: "parity/look.png" }, "parity/look.png", run("view_image")));
  it("ocr", () => expectParity("ocr", { path: "parity/scan.png" }, "parity/scan.png", run("ocr")));
  it("document", () => expectParity("document", { action: "read", file_path: "parity/doc.docx" }, "parity/doc.docx", run("document")));
  it("spreadsheet", () => expectParity("spreadsheet", { action: "read", file_path: "parity/sheet.xlsx" }, "parity/sheet.xlsx", run("spreadsheet")));
  it("pdf", () => expectParity("pdf", { action: "read", file_path: "parity/doc.pdf" }, "parity/doc.pdf", run("pdf")));
  it("presentation", () => expectParity("presentation", { action: "edit", file_path: "parity/deck.pptx", edits: "[]" }, "parity/deck.pptx", run("presentation")));
  it("preview_document", () => expectParity("preview_document", { file_path: "parity/doc.docx" }, "parity/doc.docx", run("preview_document")));
  it("create_chart", () => expectParity("create_chart", {
    file_path: "parity/chart", type: "bar", series: JSON.stringify([{ name: "s", values: [1, 2] }]),
  }, "parity/chart.png", run("create_chart")));
  it("sql_query", () => expectParity("sql_query", { database: "parity/data.db", query: "SELECT 1" }, "parity/data.db", run("sql_query")));
  it("extract_site_assets", () => expectParity("extract_site_assets", { url: "https://example.invalid/", output_dir: "parity/assets" }, "parity/assets", run("extract_site_assets")));
  it("android install_apk", () => expectParity("android", { action: "install_apk", apk_path: "parity/app.apk" }, "parity/app.apk", run("android")));
  it("memory_ingest", () => expectParity("memory_ingest", { file: "parity/export.json" }, "parity/export.json", run("memory_ingest")));
  it("edit_image", () => expectParity("edit_image", { prompt: "make it blue", image: "parity/photo.png" }, "parity/photo.png", run("edit_image")));

  it("email_send attachments: the egress guard and the email tool read the gated file", async () => {
    const args = { to: "me@example.com", subject: "s", body: "b", attachments: JSON.stringify(["parity/report.txt"]) };
    await expectParity("email_send", args, "parity/report.txt", (stamped) => canonicalizeAttachmentPath("parity/report.txt", sessionIdOf(stamped)));
    await expectParity("email_send", args, "parity/report.txt", (stamped) => checkAttachmentPaths("email_send", ["parity/report.txt"], sessionIdOf(stamped)));
  });

  it("process_start cwd", async () => {
    mkdirSync(join(workRoot, "parity-cwd"), { recursive: true });
    let spawned: ProcessSession | undefined;
    await expectParity("process_start", { command: "echo parity", cwd: "parity-cwd" }, "parity-cwd", (stamped) => {
      const started = startSession(String(stamped.command), String(stamped.cwd), undefined, sessionIdOf(stamped));
      if ("session" in started) spawned = started.session;
    });
    // Windows holds a directory a live process runs in; let it go before cleanup.
    if (spawned) {
      killSession(spawned);
      for (let i = 0; i < 50 && spawned.exitedAt === null; i++) await sleep(100);
    }
  });

  it("task-artifact pre-stat names the file the create-class tool writes", () =>
    expectParity("document", { action: "create", file_path: "parity/new.docx" }, "parity/new.docx", (stamped) => createTargetPath("document", stamped)));
});

describe("work-rooted session: the harness judges the file the gate approved", () => {
  const sandboxed = (tool: ToolDefinition, args: Record<string, unknown>, priorMessages: ChatCompletionMessageParam[] = []) =>
    runSandboxedPhase({
      tc: { id: "parity-call", name: tool.name, arguments: JSON.stringify(args) },
      priorMessages, toolMap: new Map([[tool.name, tool]]), tool, args, sessionId: SESSION,
      callContext: "local", riskLevel: "low", approvalContext: "", allowed: true, msgs: [],
    } as unknown as ToolCallContext);
  const stub = (name: string): ToolDefinition => ({
    name, description: "stub", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "ok" }),
  });

  it("the stale-read guard and the seen-record", async () => {
    await expectParity("edit", { path: "parity/edit.ts", old_string: "a", new_string: "b" }, "parity/edit.ts", (stamped) => sandboxed(stub("edit"), stamped));
    await expectParity("read", { path: "parity/seen.ts" }, "parity/seen.ts", (stamped) => sandboxed(stub("read"), stamped));
  });

  it("read-dedup counts a relative read in view as a read of the work-root file", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "r1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "parity/seen.md" }) } }] },
      { role: "tool", tool_call_id: "r1", content: "[ok]\n# notes" },
    ];
    expect(readContentInView(messages, inWorkRoot("parity/seen.md"), SESSION)).toBe(true);
  });

  describe("a file that exists only in the work root", () => {
    const raw = "parity/victim.txt";
    beforeAll(() => {
      mkdirSync(join(workRoot, "parity"), { recursive: true });
      writeFileSync(join(workRoot, raw), "user data");
    });

    it("an unnamed delete_file of it asks the user instead of passing as already absent", async () => {
      const stamped = await dispatched("delete_file", { path: raw });
      const asks = unnamedDeletes(
        [{ id: "d1", name: "delete_file", arguments: JSON.stringify({ path: stamped.path }) }],
        [{ role: "user", content: "tidy up the project" }],
        { sessionId: SESSION },
      );
      expect(asks).toEqual([{ id: "d1", path: raw }]);
    });

    it("a shell rm that left it behind is reported as not done", () => {
      expect(stillPresentAfterDelete(`rm ${raw}`, SESSION)).toEqual([raw]);
    });

    it("the delete notice names its absolute path", () => {
      const events: Array<{ type: string; files?: string[] }> = [];
      announceNoticedDeletes([{ id: "n1", path: raw }], [{ role: "tool", tool_call_id: "n1", content: "[ok] moved to the trash" }], (e) => events.push(e as never), SESSION);
      expect(events[0]?.files).toEqual([inWorkRoot(raw)]);
    });
  });

  it("the work root is outside the workspace, so a sessionless resolve could never pass these", () => {
    expect(realpathDeep(workRoot).startsWith(realpathDeep(workspaceRoot()))).toBe(false);
  });
});
