// A build's end reaches the chat that started it as something its agent acts
// on: the result queued for its next prompt, and the chat woken to take it.
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => ({ queued: [] as unknown[][], announced: [] as unknown[][] }));
vi.mock("../../ops/op-report-wake.js", () => ({ announceEndedOp: (...a: unknown[]) => calls.announced.push(a) }));
vi.mock("../../ops/pending-notifications.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ops/pending-notifications.js")>();
  return { ...real, pushPendingNotification: (...a: unknown[]) => calls.queued.push(a) };
});

const { buildEndNotice, reportBuildToChat } = await import("./report-to-chat.js");
const { formatNotificationsForSystemPrompt } = await import("../../ops/pending-notifications.js");
type Notification = import("../../ops/pending-notifications.js").PendingNotification;

const halted = {
  sessionId: "fork-89dc", opId: "op_1", projectDir: "C:\\ws\\apps\\label-check",
  chunksCommitted: 1, totalChunks: 13,
  halt: { chunk: 2, reason: "Chunk introduced 1 new test failure(s):\n  src/data/data.test.ts" },
  filesChanged: ["src/a.ts"],
};

beforeEach(() => { calls.queued.length = 0; calls.announced.length = 0; });

describe("buildEndNotice", () => {
  it("leads with how far the run got and why it stopped, on one line", () => {
    const n = buildEndNotice(halted);
    expect(n.summary).toBe("1/13 chunks landed. Halted at chunk 2: Chunk introduced 1 new test failure(s): src/data/data.test.ts");
    expect(n.next).toContain('build_plan_status(project_dir="C:/ws/apps/label-check")');
    expect(n.next).toContain('build_plan_resume(project_dir="C:/ws/apps/label-check")');
    // The chat that started the build is its lead: it writes the run's ledger (2026-11-25).
    expect(n.next).toContain("record this run in spec/ledger.md");
  });

  it("a finished build says so and points at what follows", () => {
    const n = buildEndNotice({ ...halted, chunksCommitted: 13, halt: undefined });
    expect(n.summary).toBe("13/13 chunks landed. The build finished.");
    expect(n.next).toMatch(/step that follows the build/);
    expect(n.next).toContain("record this run in spec/ledger.md");
    // Once the engine wrote the lead's entry, the chat is only asked to tell the owner.
    const written = buildEndNotice({ ...halted, chunksCommitted: 13, halt: undefined, ledgerWritten: true });
    expect(written.next).toContain("Your ledger entry for this run is in spec/ledger.md");
    expect(written.next).not.toContain("record this run in spec/ledger.md");
  });

  // label-check's chat heard only "the build finished… carry on", and asked
  // the owner whether to run the checks the engine had not (2026-11-23).
  it("a finished build with open items names each, and says the app is not done", () => {
    const n = buildEndNotice({ ...halted, chunksCommitted: 13, halt: undefined, openItems: ["scenario 05-scan.md fails (3/10): no flag", "the owner's walkthrough of the finished app is still to do"] });
    expect(n.summary).toBe("13/13 chunks landed. The build finished; the finish checks left 2 open item(s).");
    expect(n.next).toContain("- scenario 05-scan.md fails (3/10): no flag\n- the owner's walkthrough");
    expect(n.next).toContain("Do not call the app done while any is open.");
    expect(n.next).toContain("record this run in spec/ledger.md");
  });
});

describe("reportBuildToChat", () => {
  it("queues the notice for the chat that started the build and wakes it", () => {
    reportBuildToChat(halted);
    expect(calls.queued).toHaveLength(1);
    expect(calls.queued[0][0]).toBe("fork-89dc");
    expect(calls.queued[0][1]).toMatchObject({
      opId: "op_1", status: "failed", filesChanged: ["src/a.ts"], task: "The build of label-check (run_build_plan)",
      summary: expect.stringContaining("Halted at chunk 2"), toolJob: { next: expect.stringContaining("build_plan_resume") },
    });
    expect(calls.announced).toEqual([["fork-89dc", { opId: "op_1", task: "The build of label-check (run_build_plan)", status: "failed" }, false]]);
  });

  // The name was taken with the platform's own basename, which on Linux does
  // not split a Windows path: the task read "The build of C:\\ws\\apps\\label-check".
  it("names the project by its folder, however the path is spelled", () => {
    for (const projectDir of ["C:\\ws\\apps\\label-check", "C:/ws/apps/label-check", "/home/u/ws/apps/label-check"]) {
      calls.queued.length = 0;
      reportBuildToChat({ ...halted, projectDir });
      expect((calls.queued[0][1] as { task: string }).task, projectDir).toBe("The build of label-check (run_build_plan)");
    }
  });

  it("what the chat's next prompt shows carries the halt and the next call", () => {
    reportBuildToChat(halted);
    const shown = formatNotificationsForSystemPrompt([calls.queued[0][1] as Notification]);
    expect(shown).toContain("Halted at chunk 2");
    expect(shown).toContain("Next: build_plan_status");
  });

  it("a finished build is reported as completed", () => {
    reportBuildToChat({ ...halted, halt: undefined });
    expect((calls.announced[0][1] as { status: string }).status).toBe("completed");
  });
});
