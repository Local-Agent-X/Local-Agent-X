import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { captureRollback, restoreRollback, listRollbacks, ROLLBACK_DIR_PATH, ROLLBACK_INDEX_FILE } from "./rollback.js";

// Tests run against the real ~/.lax/rollback dir, which is fine because
// every contract is keyed on a unique toolCallId. We clean up our own
// toolCallId-scoped subdirs afterward and don't touch other entries.
const TEST_TC_PREFIX = "test-rb-";

function freshId(): string {
  return TEST_TC_PREFIX + Math.random().toString(36).slice(2, 10);
}

function cleanup(id: string): void {
  const dir = join(ROLLBACK_DIR_PATH, id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

describe("captureRollback", () => {
  const trackedIds: string[] = [];

  afterEach(() => {
    while (trackedIds.length) cleanup(trackedIds.pop()!);
  });

  it("workspace-write with a path arg backs up the file", () => {
    const id = freshId(); trackedIds.push(id);
    const target = join(tmpdir(), `lax-rb-target-${id}.txt`);
    writeFileSync(target, "original content");

    const contract = captureRollback(id, "write", "workspace-write", { path: target });
    expect(contract.artifacts).toHaveLength(1);
    expect(contract.artifacts[0].type).toBe("file-backup");
    if (contract.artifacts[0].type === "file-backup") {
      expect(existsSync(contract.artifacts[0].backup)).toBe(true);
      expect(readFileSync(contract.artifacts[0].backup, "utf-8")).toBe("original content");
    }
    rmSync(target, { force: true });
  });

  it("workspace-write without a recognized path arg records no-rollback with reason", () => {
    const id = freshId(); trackedIds.push(id);
    const contract = captureRollback(id, "memory_save", "workspace-write", { key: "k", value: "v" });
    expect(contract.artifacts[0].type).toBe("none");
    if (contract.artifacts[0].type === "none") {
      expect(contract.artifacts[0].reason).toContain("no recognized file-path arg");
    }
  });

  it("destructive on an existing file backs it up too", () => {
    const id = freshId(); trackedIds.push(id);
    const target = join(tmpdir(), `lax-rb-del-${id}.txt`);
    writeFileSync(target, "doomed");
    const contract = captureRollback(id, "delete_file", "destructive", { path: target });
    expect(contract.artifacts[0].type).toBe("file-backup");
    rmSync(target, { force: true });
  });

  it("destructive on a missing file records no-rollback", () => {
    const id = freshId(); trackedIds.push(id);
    const contract = captureRollback(id, "delete_file", "destructive", { path: join(tmpdir(), "does-not-exist-xyz.txt") });
    expect(contract.artifacts[0].type).toBe("none");
    if (contract.artifacts[0].type === "none") expect(contract.artifacts[0].reason).toContain("file does not exist");
  });

  it("shell in a git repo with dirty tree creates a stash", () => {
    const id = freshId(); trackedIds.push(id);
    const repo = join(tmpdir(), `lax-rb-repo-${id}`);
    mkdirSync(repo, { recursive: true });
    try {
      execSync("git init -q", { cwd: repo });
      execSync('git config user.email "t@t" && git config user.name "t"', { cwd: repo });
      writeFileSync(join(repo, "a.txt"), "v1");
      execSync("git add . && git commit -qm init", { cwd: repo });
      writeFileSync(join(repo, "a.txt"), "v2-dirty");

      const contract = captureRollback(id, "bash", "shell", { command: "echo hi" }, repo);
      expect(contract.artifacts[0].type).toBe("git-stash");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("shell in a non-git cwd records no-rollback", () => {
    const id = freshId(); trackedIds.push(id);
    const dir = join(tmpdir(), `lax-rb-nogit-${id}`);
    mkdirSync(dir, { recursive: true });
    try {
      const contract = captureRollback(id, "bash", "shell", { command: "echo hi" }, dir);
      expect(contract.artifacts[0].type).toBe("none");
      if (contract.artifacts[0].type === "none") expect(contract.artifacts[0].reason).toContain("not a git repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-applicable risk class records no-rollback with reason", () => {
    const id = freshId(); trackedIds.push(id);
    const contract = captureRollback(id, "web_search", "network-read", { query: "x" });
    expect(contract.artifacts[0].type).toBe("none");
    if (contract.artifacts[0].type === "none") {
      expect(contract.artifacts[0].reason).toContain("network-read");
    }
  });

  it("restoreRollback copies file-backup contents back to original", () => {
    const id = freshId(); trackedIds.push(id);
    const target = join(tmpdir(), `lax-rb-restore-${id}.txt`);
    writeFileSync(target, "original");
    captureRollback(id, "write", "workspace-write", { path: target });
    writeFileSync(target, "mutated-by-agent");

    const r = restoreRollback(id);
    expect(r.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("original");
    rmSync(target, { force: true });
  });

  it("restoreRollback refuses to undo twice", () => {
    const id = freshId(); trackedIds.push(id);
    const target = join(tmpdir(), `lax-rb-twice-${id}.txt`);
    writeFileSync(target, "v1");
    captureRollback(id, "write", "workspace-write", { path: target });
    writeFileSync(target, "v2");

    expect(restoreRollback(id).ok).toBe(true);
    const second = restoreRollback(id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already restored");
    rmSync(target, { force: true });
  });

  it("restoreRollback returns error for unknown toolCallId", () => {
    const r = restoreRollback("never-captured-xyz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no contract");
  });

  it("restoreRollback returns error when contract has only no-op artifacts", () => {
    const id = freshId(); trackedIds.push(id);
    captureRollback(id, "memory_save", "workspace-write", { key: "k" });
    const r = restoreRollback(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nothing to restore");
  });

  it("listRollbacks returns the most recent capture and marks restored entries", () => {
    const id = freshId(); trackedIds.push(id);
    const target = join(tmpdir(), `lax-rb-list-${id}.txt`);
    writeFileSync(target, "v1");
    captureRollback(id, "write", "workspace-write", { path: target });

    const beforeRestore = listRollbacks(50).find((e) => e.toolCallId === id);
    expect(beforeRestore).toBeDefined();
    expect(beforeRestore?.restored).toBe(false);

    writeFileSync(target, "v2");
    restoreRollback(id);

    const afterRestore = listRollbacks(50).find((e) => e.toolCallId === id);
    expect(afterRestore?.restored).toBe(true);
    rmSync(target, { force: true });
  });

  it("appends a JSON line to the index file", () => {
    const id = freshId(); trackedIds.push(id);
    const target = join(tmpdir(), `lax-rb-idx-${id}.txt`);
    writeFileSync(target, "x");
    captureRollback(id, "write", "workspace-write", { path: target });
    const idx = readFileSync(ROLLBACK_INDEX_FILE, "utf-8");
    expect(idx).toContain(id);
    rmSync(target, { force: true });
  });
});
