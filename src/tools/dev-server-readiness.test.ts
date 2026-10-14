// The one port reclaim (dev-server lifecycle AND process_restart): it kills an
// orphan holding the port, and never this process, its parent, or a process
// LAX runs for itself (browser, sidecar) — the thing process_restart used to
// do when a model named the server's own port. The process table is a fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  holders: [] as number[],
  procs: [] as Array<{ pid: number; ppid: number }>,
  tableFails: false,
  killed: [] as number[],
}));
vi.mock("./process-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-session.js")>()),
  pidsOnPort: () => seam.holders,
}));
vi.mock("./owned-listeners.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./owned-listeners.js")>()),
  processTable: () => {
    if (seam.tableFails) throw new Error("ps unavailable");
    return seam.procs;
  },
}));
vi.mock("../process-tree-kill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process-tree-kill.js")>()),
  killProcessGroupSync: (pid: number) => { seam.killed.push(pid); },
}));

import { reclaimPort, reclaimTargets } from "./dev-server-readiness.js";
import { SESSIONS, type ProcessSession } from "./process-session.js";

const SELF = 1000;
const PARENT = 900;
// LAX (1000) under the desktop app (900); it runs a browser (1100 → 1101), a
// tracked process_start session (1200 → its shell 1201 → node 1202), and an
// unrelated orphan tree (3000 → 3001) also exists.
const TABLE = [
  { pid: SELF, ppid: PARENT },
  { pid: 1100, ppid: SELF }, { pid: 1101, ppid: 1100 },
  { pid: 1200, ppid: SELF }, { pid: 1201, ppid: 1200 }, { pid: 1202, ppid: 1201 },
  { pid: 3000, ppid: 1 }, { pid: 3001, ppid: 3000 },
];
const tracked = new Set([1200]);

describe("reclaimTargets", () => {
  it("kills an orphan and a tracked session's tree; spares this process, its parent and LAX's own machinery", () => {
    const holders = [SELF, PARENT, 1100, 1101, 1200, 1202, 3000, 3001];
    expect(reclaimTargets(holders, TABLE, tracked, SELF, PARENT)).toEqual([1200, 1202, 3000, 3001]);
  });

  it("with no table, only this process and its parent are spared", () => {
    expect(reclaimTargets([SELF, PARENT, 1101, 3001], [], tracked, SELF, PARENT)).toEqual([1101, 3001]);
  });

  it("a cycle in the table ends the walk instead of hanging", () => {
    const loop = [{ pid: 5, ppid: 6 }, { pid: 6, ppid: 5 }];
    expect(reclaimTargets([5], loop, new Set(), SELF, PARENT)).toEqual([5]);
  });
});

// This process's identity is passed in rather than stubbed onto `process`:
// redefining process.ppid does not take on every Node build, and a fallback
// that then fails to spare the parent reads as a product bug it is not.
describe("reclaimPort", () => {
  let session: ProcessSession;
  beforeEach(() => {
    seam.procs = TABLE;
    seam.tableFails = false;
    seam.killed = [];
    session = { sessionId: "px-tracked", pid: 1200, exitedAt: null } as ProcessSession;
    SESSIONS.set(session.sessionId, session);
  });
  afterEach(() => {
    SESSIONS.delete(session.sessionId);
  });

  it("kills only the holders reclaimTargets allows and reports them", () => {
    seam.holders = [SELF, 1101, 1202, 3001];
    expect(reclaimPort(5180, SELF, PARENT)).toEqual([1202, 3001]);
    expect(seam.killed).toEqual([1202, 3001]);
  });

  it("an exited session's root is gone from the table, so its lingering tree is an orphan", () => {
    session.exitedAt = Date.now();
    seam.procs = TABLE.filter((p) => p.pid !== 1200);
    seam.holders = [1202];
    expect(reclaimPort(5180, SELF, PARENT)).toEqual([1202]);
  });

  it("does not read the process table when nothing holds the port", () => {
    seam.holders = [];
    seam.tableFails = true;
    expect(reclaimPort(5180, SELF, PARENT)).toEqual([]);
    expect(seam.killed).toEqual([]);
  });

  it("falls back to sparing only this process and its parent when the table cannot be read", () => {
    seam.holders = [SELF, PARENT, 1101, 3001];
    seam.tableFails = true;
    expect(reclaimPort(5180, SELF, PARENT)).toEqual([1101, 3001]);
  });
});
