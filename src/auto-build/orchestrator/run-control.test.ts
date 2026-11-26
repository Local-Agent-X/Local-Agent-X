// Pause, Resume and Cancel on a build's card. A build is not a canonical-loop
// op, so its Pause failed with "unknown_op" and its Cancel did nothing
// (2026-11-25); and a stop used to leave a part-built chunk's work loose in the
// project, for the next chunk's commit to take in.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const live = vi.hoisted(() => ({ ids: new Set<string>(), stops: [] as Array<[string, string]> }));
vi.mock("./manager.js", () => ({
  getActive: (id: string) => (live.ids.has(id) ? { opId: id } : undefined),
  stopRun: (id: string, stop: string) => { live.stops.push([id, stop]); return true; },
}));
const reg = vi.hoisted(() => ({ entries: [] as Array<{ projectDir: string; opId: string; sessionId: string; registeredAt: string }> }));
vi.mock("./registry.js", () => ({ listAll: () => reg.entries }));
const starts = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("./resume.js", () => ({
  startFromSavedState: (s: unknown, sessionId: string) => { starts.calls.push([s, sessionId]); return { kind: "started", opId: "op_b", window: {}, kept: "" }; },
}));
const sent = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock("../../ops/session-bridge.js", () => ({ broadcastToSession: (_s: string, e: Record<string, unknown>) => { sent.events.push(e); } }));
vi.mock("../workflow-state.js", () => ({ updateAppBuildWorkflow: vi.fn() }));

const { controlBuild, isBuildRun, listPausedBuilds } = await import("./run-control.js");
const { endStoppedRun } = await import("./stopped-run.js");
const state = await import("./state.js");
const { setAsideRecordFor } = await import("../failure-recovery.js");
const { ENGINE_STATE_PATTERNS } = await import("../engine-state-files.js");

function savedProject(phase: "paused" | "halted" | "running", opId = "op_b"): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-run-control-"));
  const s = state.makeInitial({ opId, sessionId: "chat-1", projectDir: dir, planPath: join(dir, "plan.md"), totalChunks: 5, startingChunk: 1 });
  state.write(phase === "paused" ? state.markPaused(s) : phase === "halted" ? state.markHalted(s, 3, "loop", "x") : { ...s, phase });
  reg.entries.push({ projectDir: dir, opId, sessionId: "chat-1", registeredAt: new Date().toISOString() });
  return dir;
}

beforeEach(() => { live.ids.clear(); live.stops = []; reg.entries = []; starts.calls = []; sent.events = []; });

describe("controlBuild", () => {
  it("a running build: Pause and Cancel stop it with what was asked, Resume has nothing to do", () => {
    live.ids.add("op_live");
    expect(isBuildRun("op_live")).toBe(true);
    expect(controlBuild("op_live", "pause")).toEqual({ ok: true });
    expect(controlBuild("op_live", "cancel")).toEqual({ ok: true });
    expect(controlBuild("op_live", "resume")).toEqual({ ok: true });
    expect(live.stops).toEqual([["op_live", "paused"], ["op_live", "cancelled"]]);
  });

  it("a paused build: Resume starts it from its saved state, under its own id", () => {
    savedProject("paused");
    expect(isBuildRun("op_b")).toBe(true);
    expect(controlBuild("op_b", "resume")).toEqual({ ok: true });
    expect(starts.calls).toHaveLength(1);
    expect((starts.calls[0] as [{ opId: string }, string])[0].opId).toBe("op_b");
    expect(listPausedBuilds().map((b) => b.opId)).toEqual(["op_b"]);
  });

  it("a paused build can be cancelled; a halted one is not resumed from the card", () => {
    const dir = savedProject("paused");
    expect(controlBuild("op_b", "cancel")).toEqual({ ok: true });
    expect(state.read(dir)?.phase).toBe("halted");
    expect(sent.events.at(-1)).toMatchObject({ type: "bg_op_completed", status: "cancelled" });
    expect(controlBuild("op_b", "resume")).toMatchObject({ ok: false, message: expect.stringContaining("not paused") });
  });

  it("an id that is no build is left to the other controls", () => {
    expect(isBuildRun("op_canonical")).toBe(false);
    expect(controlBuild("op_canonical", "pause")).toMatchObject({ ok: false });
  });
});

describe("endStoppedRun", () => {
  it("a pause keeps the part-built chunk's work on its branch with its round, and the card reads paused", () => {
    const dir = savedProject("running");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(dir, ".git", "info", "exclude"), ENGINE_STATE_PATTERNS.join("\n") + "\n");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    const preSha = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "fix.ts"), "export const fixed = true;\n");
    const run = { opId: "op_b", sessionId: "chat-1", projectDir: dir, liveState: { ...state.read(dir)!, inTreeChunk: { chunk: 1013, title: "Finish fix 1: auditor findings", preSha, round: 4, findings: ["a", "b"] } } };

    endStoppedRun(run, "paused");

    expect(state.read(dir)).toMatchObject({ phase: "paused" });
    expect(state.read(dir)?.inTreeChunk).toBeUndefined();
    expect(git("status", "--porcelain")).toBe("");
    expect(git("show", "autobuild/c1013:fix.ts")).toBe("export const fixed = true;");
    expect(setAsideRecordFor(dir, 1013)).toMatchObject({ findings: ["a", "b"], round: 4 });
    expect(sent.events.at(-1)).toMatchObject({ type: "bg_op_progress", opId: "op_b", status: "paused" });
    expect(String(sent.events.at(-1)?.line)).toContain("fix round 4");
  });
});
