/**
 * Behavior tests for the external-change-diff middleware: files a session has
 * read that then change on disk OUTSIDE the turn's own tool calls get ONE
 * nudge carrying compact unified diffs against the session's cached snapshot;
 * settled changes stay silent, gone files evict, and the harness's own edits
 * are exempt. Real temp files against the real read-state store — no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { externalChangeDiffMiddleware } from "./external-change-diff.js";
import { recordFileSeen, checkFreshness, forgetSessionReads } from "../../tools/read-state.js";
import { trackOpForSession } from "../../ops/session-bridge.js";
import type { CanonicalLoopContext } from "./types.js";

let _n = 0;
/** Fresh op+session pair per case, with the op→session mapping the middleware
 *  resolves via getSessionForOp (the same bridge chat/agent runners populate). */
function ids(): { op: string; session: string } {
  _n++;
  const pair = { op: `op-ecd-${_n}`, session: `sess-ecd-${_n}` };
  trackOpForSession(pair.op, pair.session);
  sessions.add(pair.session);
  return pair;
}

function ctxFor(op: string, over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: op, lane: "agent" },
    turnIdx: 1,
    assistantContent: "",
    toolCalls: [],
    toolResults: [],
    toolsCalledThisOp: new Set<string>(),
    committingToolsThisOp: new Set<string>(),
    attemptedToolsThisOp: new Set<string>(),
    evidenceHistory: [],
    ...over,
  } as unknown as CanonicalLoopContext;
}

function fire(op: string, over: Partial<CanonicalLoopContext> = {}) {
  return externalChangeDiffMiddleware.afterToolExecution!(ctxFor(op, over));
}

let dir: string;
const sessions = new Set<string>();
let mtimeBump = 0;

/** Write + force an mtime delta so the sweep's mtime prefilter sees a bump. */
function writeBumped(file: string, content: string): void {
  writeFileSync(file, content, "utf-8");
  mtimeBump += 5_000;
  const bumped = new Date(Date.now() + mtimeBump);
  utimesSync(file, bumped, bumped);
}

beforeEach(() => {
  // realpathSync: os.tmpdir() is a symlink on macOS; read-state canonicalizes
  // its keys, so tests compare against the resolved spelling.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ext-change-diff-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const s of sessions) forgetSessionReads(s);
  sessions.clear();
  delete process.env.LAX_EXTERNAL_CHANGE_DIFF;
});

describe("external-change-diff", () => {
  it("an external modification nudges ONCE with a unified diff, then goes silent", async () => {
    const { op, session } = ids();
    const file = join(dir, "watched.ts");
    writeFileSync(file, "export const a = 1;\n", "utf-8");
    recordFileSeen(session, file);

    writeBumped(file, "export const a = 2;\n"); // external change
    const r = await fire(op);
    expect(r).toMatchObject({ kind: "nudge", reason: "external-change-diff" });
    if (r.kind === "nudge") {
      expect(r.message).toContain(file);
      expect(r.message).toContain("-export const a = 1;");
      expect(r.message).toContain("+export const a = 2;");
    }

    // The full diff was shown → the disk state is the session's new baseline:
    // no re-notification, and the edit gate treats the file as seen.
    expect((await fire(op)).kind).toBe("continue");
    expect(checkFreshness(session, file)).toBe("ok");
  });

  it("a truncated diff notes it honestly and keeps the edit gate stale", async () => {
    const { op, session } = ids();
    const file = join(dir, "big-change.ts");
    const before = Array.from({ length: 80 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
    writeFileSync(file, before, "utf-8");
    recordFileSeen(session, file);

    const after = Array.from({ length: 80 }, (_, i) => `const v${i} = ${i + 1};`).join("\n") + "\n";
    writeBumped(file, after);
    const r = await fire(op);
    expect(r).toMatchObject({ kind: "nudge" });
    if (r.kind === "nudge") expect(r.message).toContain("truncated");

    // Re-notification stops, but the model never saw the full bytes — an edit
    // must still be forced through a real re-read.
    expect((await fire(op)).kind).toBe("continue");
    expect(checkFreshness(session, file)).toBe("stale");
  });

  it("a deleted file never nudges and evicts after two sweeps", async () => {
    const { op, session } = ids();
    const file = join(dir, "doomed.txt");
    writeFileSync(file, "bye\n", "utf-8");
    recordFileSeen(session, file);

    rmSync(file);
    expect((await fire(op)).kind).toBe("continue"); // transient miss: kept
    expect(checkFreshness(session, file)).toBe("ok"); // still tracked (missing file is the tool's problem)
    expect((await fire(op)).kind).toBe("continue"); // second miss: evicted
    expect(checkFreshness(session, file)).toBe("unseen");
  });

  it("the harness's own successful edit this turn is exempt from the sweep", async () => {
    const { op, session } = ids();
    const file = join(dir, "self-edit.ts");
    writeFileSync(file, "old\n", "utf-8");
    recordFileSeen(session, file);
    writeBumped(file, "new\n");

    const r = await fire(op, {
      toolCalls: [{ toolCallId: "e1", tool: "edit", args: { file_path: file } }],
      toolResults: [{ toolCallId: "e1", toolName: "edit", content: "ok", status: "ok" }],
    } as Partial<CanonicalLoopContext>);
    expect(r.kind).toBe("continue");
  });

  it("a FAILED edit does not exempt the file — the change still reads as external", async () => {
    const { op, session } = ids();
    const file = join(dir, "failed-edit.ts");
    writeFileSync(file, "old\n", "utf-8");
    recordFileSeen(session, file);
    writeBumped(file, "new\n");

    const r = await fire(op, {
      toolCalls: [{ toolCallId: "e1", tool: "edit", args: { file_path: file } }],
      toolResults: [{ toolCallId: "e1", toolName: "edit", content: "boom", status: "error" }],
    } as Partial<CanonicalLoopContext>);
    expect(r.kind).toBe("nudge");
  });

  it("a change to a REDACTED-read file gets a diff-less notice — the withheld bytes never reach the nudge", async () => {
    const { op, session } = ids();
    const file = join(dir, ".env.local");
    writeFileSync(file, "TOKEN=originalhushvalue\n", "utf-8");
    // The phase layer records a redacted sensitive read as hash-only state
    // (no snapshot, partial) — mirror that record here.
    recordFileSeen(session, file, { partial: false, redacted: true });

    writeBumped(file, "TOKEN=replacedhushvalue\n"); // external change
    const r = await fire(op);
    expect(r).toMatchObject({ kind: "nudge" });
    if (r.kind === "nudge") {
      expect(r.message).toContain(file);
      expect(r.message).toContain("no diff available");
      // Neither the cached secret nor the new one may leak through the nudge.
      expect(r.message).not.toContain("originalhushvalue");
      expect(r.message).not.toContain("replacedhushvalue");
    }
    // Diff-less notice: quiet afterwards, but the edit gate stays stale so any
    // edit is forced through a real (re-redacted) read.
    expect((await fire(op)).kind).toBe("continue");
    expect(checkFreshness(session, file)).toBe("stale");
  });

  it("an op with no session mapping stays inert", async () => {
    const r = await fire("op-ecd-untracked");
    expect(r.kind).toBe("continue");
  });

  it("kill switch LAX_EXTERNAL_CHANGE_DIFF=0 → inert", async () => {
    const { op, session } = ids();
    const file = join(dir, "killed.txt");
    writeFileSync(file, "old\n", "utf-8");
    recordFileSeen(session, file);
    writeBumped(file, "new\n");
    process.env.LAX_EXTERNAL_CHANGE_DIFF = "0";
    expect((await fire(op)).kind).toBe("continue");
  });

  it("runs on ALL lanes (no `when`) — external edits matter in interactive chat too", () => {
    expect(externalChangeDiffMiddleware.when).toBeUndefined();
  });
});
