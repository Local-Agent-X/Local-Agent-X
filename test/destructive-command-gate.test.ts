import { describe, it, expect } from "vitest";
import {
  isDestructiveCommand,
  getApprovalManager,
} from "../src/approval-manager.js";
import type { ServerEvent } from "../src/types.js";

// Floor under the autonomy profile: a small set of irreversible shell ops must
// always confirm, even when a relaxed profile would auto-allow them, and must
// not be remembered for the session. isDestructiveCommand() is the matcher;
// requestApproval({ alwaysAsk }) is the cache-bypass that enforces "every time".

describe("isDestructiveCommand — flags irreversible shell operations", () => {
  const destructive: Array<[string, string]> = [
    ["git push --force", "git force-push"],
    ["git push --force-with-lease origin main", "git force-push"],
    ["git push -f origin main", "git force-push"],
    ["git push origin --delete feature", "git delete remote branch"],
    ["git reset --hard HEAD~3", "git reset --hard"],
    ["git clean -fd", "git clean -f"],
    ["git clean -fdx", "git clean -f"],
    ["git branch -D feature", "git force-delete branch"],
    ["git filter-branch --tree-filter rm", "git history rewrite"],
    ["rm -rf /tmp/build", "rm -rf"],
    ["rm -fr ./dist", "rm -fr"],
    ["rm -r -f node_modules", "rm -r -f"],
    ["sudo dd if=/dev/zero of=/dev/sda", "dd to a raw device"],
    ["mkfs.ext4 /dev/sdb1", "filesystem format"],
    // Native Windows forms. Every one of these MISSED before 2026-09-21; the
    // third is verbatim the command that destroyed three fixture originals.
    ["Remove-Item -Force -Recurse workspace/client-data", "Remove-Item -Recurse"],
    ["Remove-Item -Recurse -Force .\build", "Remove-Item -Recurse"],
    ["powershell.exe -Command \"Remove-Item -Force -Recurse 'C:\Users\peter\ws\client-data'\"", "Remove-Item -Recurse"],
    ["pwsh -c \"Remove-Item -Rec -Force ./dist\"", "Remove-Item -Recurse"],
    ["Remove-Item -r ./node_modules", "Remove-Item -Recurse"],
    ["rm -Recurse -Force ./dist", "Remove-Item -Recurse (alias)"],
    ["ri -Recurse out", "Remove-Item -Recurse (alias)"],
    ["cmd /c rd /s /q workspace\client-data", "rd /s"],
    ["rmdir /S /Q build", "rd /s"],
    ["del /s /q workspace\client-data\*.tmp", "del /s"],
    ["cmd.exe /c \"del /q /s C:\ws\client-data\"", "del /s"],
  ];

  for (const [cmd, reason] of destructive) {
    it(`flags: ${cmd}`, () => {
      expect(isDestructiveCommand("bash", { command: cmd })).toBe(reason);
    });
  }

  const benign = [
    "git push origin main",
    "git push",
    "git reset --soft HEAD~1",
    "git status",
    "git log --oneline",
    "rm file.txt",
    "rm -r build", // -r without -f is not the catastrophic form
    "Remove-Item file.txt",            // single file, no tree
    "Remove-Item -Force file.txt",     // -Force alone is rm -f, not rm -rf
    "del /q file.txt",                 // /q silences the prompt; /s makes it a tree
    "rd empty-dir",                    // no /s: only an empty directory
    "Get-ChildItem -Recurse src",      // -Recurse on a READ is not a delete
    "rm -r build | Remove-Item",       // the flag belongs to the rm, not to a Remove-Item after the pipe
    "ls -la",
    "echo 'rm -rf is just text here in quotes'".replace(/rm -rf/, "remove"),
  ];

  for (const cmd of benign) {
    it(`does not flag: ${cmd}`, () => {
      expect(isDestructiveCommand("bash", { command: cmd })).toBeNull();
    });
  }

  it("applies to shell aliases but not non-shell tools", () => {
    expect(isDestructiveCommand("shell", { command: "rm -rf /x" })).toBe("rm -rf");
    expect(isDestructiveCommand("ari_shell", { command: "rm -rf /x" })).toBe("rm -rf");
    expect(isDestructiveCommand("write", { path: "/x", content: "rm -rf /" })).toBeNull();
    expect(isDestructiveCommand("bash", {})).toBeNull();
  });
});

describe("requestApproval({ alwaysAsk }) — destructive ops never auto-resolve", () => {
  function capture() {
    const events: ServerEvent[] = [];
    let lastId: string | undefined;
    const emit = (e: ServerEvent) => {
      events.push(e);
      if (e.type === "approval_requested") lastId = e.approvalId;
    };
    return { events, emit, id: () => lastId };
  }

  it("ignores a prior session grant for the identical command", async () => {
    const mgr = getApprovalManager();
    const sessionId = "destructive-test-1";
    mgr.clearSession(sessionId);

    // Seed a normal (non-alwaysAsk) remembered grant for the exact command.
    const c1 = capture();
    const p1 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "t1",
      sessionId,
      context: "",
      args: { command: "git push --force" },
      emit: c1.emit,
    });
    mgr.resolveApproval(c1.id()!, true, true);
    await expect(p1).resolves.toBe(true);

    // Same command via the alwaysAsk path must still prompt (no short-circuit).
    const c2 = capture();
    let resolved2 = false;
    const p2 = mgr
      .requestApproval({
        toolName: "bash",
        toolCallId: "t2",
        sessionId,
        context: "",
        args: { command: "git push --force" },
        alwaysAsk: true,
        emit: c2.emit,
      })
      .then((v) => {
        resolved2 = true;
        return v;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved2).toBe(false);
    expect(c2.events.filter((e) => e.type === "approval_requested")).toHaveLength(1);

    mgr.resolveApproval(c2.id()!, false, false);
    await expect(p2).resolves.toBe(false);
    mgr.clearSession(sessionId);
  });

  it("does not remember an alwaysAsk approval even with rememberForSession=true", async () => {
    const mgr = getApprovalManager();
    const sessionId = "destructive-test-2";
    mgr.clearSession(sessionId);

    // Approve a destructive op and ask to remember it.
    const c1 = capture();
    const p1 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "t1",
      sessionId,
      context: "",
      args: { command: "rm -rf /tmp/x" },
      alwaysAsk: true,
      emit: c1.emit,
    });
    mgr.resolveApproval(c1.id()!, true, true);
    await expect(p1).resolves.toBe(true);

    // The next identical destructive op must prompt again (not cached).
    const c2 = capture();
    let resolved2 = false;
    const p2 = mgr
      .requestApproval({
        toolName: "bash",
        toolCallId: "t2",
        sessionId,
        context: "",
        args: { command: "rm -rf /tmp/x" },
        alwaysAsk: true,
        emit: c2.emit,
      })
      .then((v) => {
        resolved2 = true;
        return v;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved2).toBe(false);
    expect(c2.events.filter((e) => e.type === "approval_requested")).toHaveLength(1);

    mgr.resolveApproval(c2.id()!, false, false);
    await expect(p2).resolves.toBe(false);
    mgr.clearSession(sessionId);
  });
});
