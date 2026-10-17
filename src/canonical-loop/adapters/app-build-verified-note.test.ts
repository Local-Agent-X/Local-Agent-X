/**
 * A build the harness opened and passed says so, durably.
 *
 * Live 2026-10-16: the smoke gate loaded, clicked and screenshotted a water
 * tracker, but its "[verify] smoke passed" line was a stream chunk that died
 * with the live bubble. The inbox, op_wait and the phone card read the op's
 * last assistant row, which was the builder's own report: "I still haven't
 * opened the app in a browser." These pin that a passing gate now ends the
 * turn with a VERIFIED row that keeps the deliverable.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import { AppBuildVerifyAdapter } from "./app-build-verify-adapter.js";
import { composeVerifiedNote, SMOKE_VERIFIED_MARKER, SMOKE_NO_BROWSER_MARKER } from "./app-build-unverified-note.js";
import type { AppSmokeGateRunner, AppVisionJudge } from "./app-build-smoke-gate.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const BUILDER_TEXT = "Built it. I still haven't opened the app in a browser.\n\nAPP_READY: http://127.0.0.1:7007/apps/tracker/index.html";

function staticApp(): string {
  const root = mkdtempSync(join(tmpdir(), "verified-note-"));
  roots.push(root);
  const dir = join(root, "apps", "tracker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head><body>ok</body></html>`);
  return dir;
}

function builder(): Adapter {
  return {
    name: "fake-builder",
    version: "1",
    async runTurn(_input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      report({ kind: "message_finalized", message: { messageId: "am-b", role: "assistant", content: { text: BUILDER_TEXT } } });
      return { providerState: { adapterName: "fake-builder", adapterVersion: "1", providerPayload: {} }, terminalReason: "done" } as TurnResult;
    },
    async abort() {},
  } as unknown as Adapter;
}

const passingSmoke: AppSmokeGateRunner = async () => ({ verdict: "pass", screenshotPath: "/tmp/s.png", interactionScreenshotPath: "/tmp/s2.png" });

async function run(judge: AppVisionJudge, brief = "a water tracker"): Promise<{ result: TurnResult; reports: AdapterReport[] }> {
  const adapter = new AppBuildVerifyAdapter(builder(), staticApp(), undefined, passingSmoke, { brief, judge });
  const reports: AdapterReport[] = [];
  const result = await adapter.runTurn({ opId: "op_t", turnIdx: 3, messages: [], tools: [] } as TurnInput, (r) => reports.push(r));
  return { result, reports };
}

function lastAssistantText(reports: AdapterReport[]): string {
  const rows = reports.filter((r) => r.kind === "message_finalized" && r.message.role === "assistant");
  const last = rows[rows.length - 1] as Extract<AdapterReport, { kind: "message_finalized" }>;
  return String((last.message.content as { text?: string }).text ?? "");
}

describe("a passing smoke ends the build with a durable receipt", () => {
  it("the last assistant row is the VERIFIED note, carrying the deliverable", async () => {
    const { result, reports } = await run(async () => ({ ok: true, reason: "" }));
    expect(result.terminalReason).toBe("done");
    const text = lastAssistantText(reports);
    expect(text.startsWith(SMOKE_VERIFIED_MARKER)).toBe(true);
    expect(text).toMatch(/^APP_READY: http:\/\/127\.0\.0\.1:7007\/apps\/tracker\/index\.html$/m);
    expect(text).toContain("its main action worked");
    expect(text).toContain("it matched");
    expect(text, "the builder's report still rides along").toContain("Built it.");
  });

  it("says so when the vision check could not run, and never claims it passed", async () => {
    const { reports } = await run(async () => null);
    const text = lastAssistantText(reports);
    expect(text.startsWith(SMOKE_VERIFIED_MARKER)).toBe(true);
    expect(text).toContain("could not run");
    expect(text).not.toContain("it matched");
  });

  it("a vision check that is not satisfied still ends on the NOT VERIFIED note, not a receipt", async () => {
    const { reports } = await run(async () => ({ ok: false, reason: "looks off" }));
    expect(lastAssistantText(reports).startsWith(SMOKE_NO_BROWSER_MARKER)).toBe(true);
  });
});

describe("composeVerifiedNote", () => {
  it("falls back to the gate's URL when the builder named none, and keeps it near the top", () => {
    const text = composeVerifiedNote({ builderText: "done", url: "http://x/apps/a/", interacted: false, judge: "not-run" });
    const lines = text.split("\n");
    expect(lines[1]).toBe("APP_READY: http://x/apps/a/");
    expect(lines[0]).not.toContain("main action");
  });
});
