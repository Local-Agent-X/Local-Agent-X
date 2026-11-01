import { describe, it, expect, afterEach } from "vitest";
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  captureBeforeCall, recordCapture, restoreRollback, listRollbacks, pruneRollbacks, readContracts,
  ROLLBACK_DIR_PATH, ROLLBACK_INDEX_FILE, type RollbackContract,
} from "./rollback.js";

// A restore asks the file-access layer whether its target may be written, and
// that layer keeps writes inside the home directory (here, the test's own).
const homeFile = (name: string): string => join(homedir(), name);

const TEST_TC_PREFIX = "test-rb-";

function freshId(): string {
  return TEST_TC_PREFIX + Math.random().toString(36).slice(2, 10);
}

function cleanup(id: string): void {
  const dir = join(ROLLBACK_DIR_PATH, id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

const call = (toolCallId: string, tool = "write") => ({ toolCallId, tool, sessionId: "s-1", opId: "op-1" });

/** A call through both steps: copy before, `act` (what the call does), record after. */
function capture(c: ReturnType<typeof call>, paths: string[], act: () => void = () => {}, now?: number) {
  const pending = captureBeforeCall(c, paths, now);
  act();
  return recordCapture(pending);
}

describe("captureBeforeCall", () => {
  const trackedIds: string[] = [];
  afterEach(() => {
    while (trackedIds.length) cleanup(trackedIds.pop()!);
  });

  it("copies aside a file the call may change", () => {
    const id = freshId(); trackedIds.push(id);
    const target = join(tmpdir(), `lax-rb-target-${id}.txt`);
    writeFileSync(target, "original content");
    const a = captureBeforeCall(call(id), [target])!.entries[0].artifact;
    expect(a.type).toBe("file-backup");
    if (a.type === "file-backup") expect(readFileSync(a.backup, "utf-8")).toBe("original content");
    rmSync(target, { force: true });
  });

  it("keeps two files of the same name apart", () => {
    const id = freshId(); trackedIds.push(id);
    const a = join(tmpdir(), `lax-rb-a-${id}`), b = join(tmpdir(), `lax-rb-b-${id}`);
    mkdirSync(a); mkdirSync(b);
    writeFileSync(join(a, "index.ts"), "A"); writeFileSync(join(b, "index.ts"), "B");
    const backups = captureBeforeCall(call(id), [join(a, "index.ts"), join(b, "index.ts")])!.entries
      .map(({ artifact: x }) => (x.type === "file-backup" ? readFileSync(x.backup, "utf-8") : x.type));
    expect(backups).toEqual(["A", "B"]);
    rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true });
  });

  it("says why a folder is not copied", () => {
    const id = freshId(); trackedIds.push(id);
    const a = captureBeforeCall(call(id, "delete_file"), [tmpdir()])!.entries[0].artifact;
    expect(a.type).toBe("none");
    if (a.type === "none") expect(a.reason).toContain("restore_file");
  });

  it("captures nothing for a call that names no file", () => {
    expect(captureBeforeCall(call(freshId(), "remember"), [])).toBeNull();
  });
});

describe("recordCapture keeps what the call changed", () => {
  it("records a rewritten file, tagged with its session and request, on the index", () => {
    const id = freshId();
    const target = join(tmpdir(), `lax-rb-rec-${id}.txt`);
    writeFileSync(target, "before");
    const contract = capture(call(id), [target], () => writeFileSync(target, "after"))!;
    expect(contract).toMatchObject({ toolCallId: id, tool: "write", sessionId: "s-1", opId: "op-1" });
    expect(contract.artifacts.map((a) => a.type)).toEqual(["file-backup"]);
    expect(readFileSync(ROLLBACK_INDEX_FILE, "utf-8")).toContain(id);
    cleanup(id); rmSync(target, { force: true });
  });

  it("records a rewrite inside one clock tick: same size, same time stamp, other bytes", () => {
    const id = freshId();
    const target = join(tmpdir(), `lax-rb-tick-${id}.txt`);
    writeFileSync(target, "aaaa");
    const t = new Date(2026, 0, 1);
    utimesSync(target, t, t);
    const contract = capture(call(id), [target], () => { writeFileSync(target, "bbbb"); utimesSync(target, t, t); });
    expect(contract?.artifacts.map((a) => a.type)).toEqual(["file-backup"]);
    cleanup(id); rmSync(target, { force: true });
  });

  it("records a deleted file and a created one", () => {
    const id = freshId();
    const gone = join(tmpdir(), `lax-rb-gone-${id}.txt`), made = join(tmpdir(), `lax-rb-made-${id}.txt`);
    writeFileSync(gone, "x");
    const contract = capture(call(id), [gone, made], () => { rmSync(gone); writeFileSync(made, "y"); })!;
    expect(contract.artifacts).toEqual([
      expect.objectContaining({ type: "file-backup", original: gone }),
      { type: "created", original: made },
    ]);
    cleanup(id); rmSync(made, { force: true });
  });

  it("records nothing, and keeps no copy, for files the call only read", () => {
    const id = freshId();
    const script = join(tmpdir(), `lax-rb-read-${id}.py`);
    writeFileSync(script, "print(1)");
    expect(capture(call(id, "bash"), [script, join(tmpdir(), `lax-rb-never-${id}.txt`)])).toBeNull();
    expect(existsSync(join(ROLLBACK_DIR_PATH, id))).toBe(false);
    expect(readContracts().some((c) => c.toolCallId === id)).toBe(false);
    rmSync(script, { force: true });
  });
});

describe("restoreRollback", () => {
  it("copies a backup back over the file", async () => {
    const id = freshId();
    const target = homeFile(`lax-rb-restore-${id}.txt`);
    writeFileSync(target, "original");
    capture(call(id), [target], () => writeFileSync(target, "mutated-by-agent"));

    expect((await restoreRollback(id)).ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("original");
    rmSync(target, { force: true });
  });

  it("moves a file the call created out of the way", async () => {
    const id = freshId();
    const target = homeFile(`lax-rb-created-${id}.txt`);
    capture(call(id), [target], () => writeFileSync(target, "made by the agent"));

    expect((await restoreRollback(id)).ok).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses to undo twice", async () => {
    const id = freshId();
    const target = homeFile(`lax-rb-twice-${id}.txt`);
    writeFileSync(target, "v1");
    capture(call(id), [target], () => writeFileSync(target, "v2"));

    expect((await restoreRollback(id)).ok).toBe(true);
    const second = await restoreRollback(id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already restored");
    rmSync(target, { force: true });
  });

  it("returns an error for an unknown toolCallId", async () => {
    const r = await restoreRollback("never-captured-xyz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no contract");
  });

  it("listRollbacks marks restored entries", async () => {
    const id = freshId();
    const target = homeFile(`lax-rb-list-${id}.txt`);
    writeFileSync(target, "v1");
    capture(call(id), [target], () => writeFileSync(target, "v2"));
    expect(listRollbacks(50).find((e) => e.toolCallId === id)?.restored).toBe(false);
    await restoreRollback(id);
    expect(listRollbacks(50).find((e) => e.toolCallId === id)?.restored).toBe(true);
    rmSync(target, { force: true });
  });
});

describe("pruneRollbacks", () => {
  it("drops contracts past the 30-day window with their backups, and keeps the rest", () => {
    const old = freshId(), fresh = freshId();
    const target = join(tmpdir(), `lax-rb-prune-${old}.txt`);
    writeFileSync(target, "x");
    const now = Date.now();
    capture(call(old), [target], () => writeFileSync(target, "y"), now - 31 * 24 * 3_600_000);
    capture(call(fresh), [target], () => writeFileSync(target, "zz"), now);

    expect(pruneRollbacks(now)).toBeGreaterThanOrEqual(1);
    const ids = readContracts().map((c) => c.toolCallId);
    expect(ids).not.toContain(old);
    expect(ids).toContain(fresh);
    expect(existsSync(join(ROLLBACK_DIR_PATH, old))).toBe(false);
    cleanup(fresh);
    rmSync(target, { force: true });
  });
});

// The index is an ordinary file under ~/.lax that any file writer can append
// to, so these forge lines in it the way a prompt-injected agent could, then
// ask for the restore a user would click.
describe("restore trusts nothing the index names", () => {
  const forge = (contract: RollbackContract): void => {
    mkdirSync(ROLLBACK_DIR_PATH, { recursive: true });
    appendFileSync(ROLLBACK_INDEX_FILE, JSON.stringify(contract) + "\n");
  };
  const backupFor = (id: string, body: string): string => {
    mkdirSync(join(ROLLBACK_DIR_PATH, id), { recursive: true });
    const backup = join(ROLLBACK_DIR_PATH, id, "x.bak");
    writeFileSync(backup, body);
    return backup;
  };

  it("capture refuses a tool-call id that is not a plain name, so no backup lands outside the rollback dir", () => {
    const escape = `escape-${Math.random().toString(36).slice(2, 10)}`;
    const target = homeFile(`lax-rb-esc-${escape}.txt`);
    writeFileSync(target, "x");
    try {
      const c = captureBeforeCall(call(`../${escape}`), [target])!;
      expect(c.entries[0].artifact.type).toBe("none");
      expect(existsSync(join(ROLLBACK_DIR_PATH, "..", escape))).toBe(false);
    } finally {
      rmSync(join(ROLLBACK_DIR_PATH, "..", escape), { recursive: true, force: true });
      rmSync(target, { force: true });
    }
  });

  it("refuses an id that would make the post-restore cleanup delete the data dir", async () => {
    const canary = join(ROLLBACK_DIR_PATH, "..", "canary.txt");
    writeFileSync(canary, "still here");
    const original = homeFile(`lax-rb-dotdot-${Math.random().toString(36).slice(2, 10)}.txt`);
    forge({ toolCallId: "..", ts: Date.now(), tool: "write",
      artifacts: [{ type: "file-backup", original, backup: join(ROLLBACK_DIR_PATH, "..", "canary.txt") }] });
    try {
      expect((await restoreRollback("..")).ok).toBe(false);
      expect(existsSync(canary)).toBe(true);
    } finally {
      rmSync(canary, { force: true });
      rmSync(original, { force: true });
    }
  });

  it("refuses to copy a backup over a path the file-access layer will not let a write reach", async () => {
    const id = freshId();
    const sshDir = join(homedir(), ".ssh");
    const madeSshDir = mkdirSync(sshDir, { recursive: true }) !== undefined;
    const original = join(sshDir, `authorized_keys_${id}`);
    forge({ toolCallId: id, ts: Date.now(), tool: "write",
      artifacts: [{ type: "file-backup", original, backup: backupFor(id, "ssh-ed25519 AAAA attacker") }] });
    try {
      expect((await restoreRollback(id)).ok).toBe(false);
      expect(existsSync(original)).toBe(false);
    } finally {
      cleanup(id);
      rmSync(original, { force: true });
      if (madeSshDir) rmdirSync(sshDir);
    }
  });

  it("refuses to remove a 'created' file the file-access layer will not let a delete reach", async () => {
    const id = freshId();
    const sshDir = join(homedir(), ".ssh");
    const madeSshDir = mkdirSync(sshDir, { recursive: true }) !== undefined;
    const original = join(sshDir, `known_hosts_${id}`);
    writeFileSync(original, "the user's own");
    forge({ toolCallId: id, ts: Date.now(), tool: "write", artifacts: [{ type: "created", original }] });
    try {
      expect((await restoreRollback(id)).ok).toBe(false);
      expect(readFileSync(original, "utf-8")).toBe("the user's own");
    } finally {
      rmSync(original, { force: true });
      if (madeSshDir) rmdirSync(sshDir);
    }
  });

  it("refuses a backup this call never captured, so a restore cannot copy any file it names into reach", async () => {
    const id = freshId();
    const secret = homeFile(`lax-rb-secret-${id}.txt`);
    const leak = homeFile(`lax-rb-leak-${id}.txt`);
    writeFileSync(secret, "s3cret");
    forge({ toolCallId: id, ts: Date.now(), tool: "write",
      artifacts: [{ type: "file-backup", original: leak, backup: secret }] });
    try {
      expect((await restoreRollback(id)).ok).toBe(false);
      expect(existsSync(leak)).toBe(false);
    } finally {
      rmSync(secret, { force: true });
      rmSync(leak, { force: true });
    }
  });

  it("refuses a backup that is a link out of the call's own directory", async (ctx) => {
    const id = freshId();
    const secret = homeFile(`lax-rb-linked-${id}.txt`);
    const leak = homeFile(`lax-rb-linkleak-${id}.txt`);
    writeFileSync(secret, "s3cret");
    mkdirSync(join(ROLLBACK_DIR_PATH, id), { recursive: true });
    const backup = join(ROLLBACK_DIR_PATH, id, "x.bak");
    try {
      try { symlinkSync(secret, backup, "file"); } catch { ctx.skip(); }
      forge({ toolCallId: id, ts: Date.now(), tool: "write",
        artifacts: [{ type: "file-backup", original: leak, backup }] });
      expect((await restoreRollback(id)).ok).toBe(false);
      expect(existsSync(leak)).toBe(false);
    } finally {
      cleanup(id);
      rmSync(secret, { force: true });
      rmSync(leak, { force: true });
    }
  });
});
