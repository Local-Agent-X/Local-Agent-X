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
    // A literal that RUNS stays scanned: command substitution in double quotes,
    // a destructive command beside a message, a body a shell executes.
    ['git commit -m "$(rm -rf ~/work)"', "rm -rf"],
    ["git commit -m \"`rm -rf ~/work`\"", "rm -rf"],
    ['git commit -m "ok" && rm -rf dist', "rm -rf"],
    ['git commit -m "ok"; git reset --hard HEAD~1', "git reset --hard"],
    ['grep -rn "x" . && rm -r build', "rm -r"],
    ['bash -c "rm -rf /tmp/x"', "rm -rf"],
    ['echo "rm -rf ~" | sh', "rm -rf"],
    ['grep "$(rm -rf ~)" file', "rm -rf"],
    ["git branch --delete --force feature", "git force-delete branch"],
    ["git branch -d -f feature", "git force-delete branch"],
    ["git branch -df feature", "git force-delete branch"],
    ["cd \"/c/Users/peter/Scan Progress\" && git branch -D agent/field-agent-1", "git force-delete branch"],
    ["git filter-branch --tree-filter rm", "git history rewrite"],
    ["rm -rf /tmp/build", "rm -rf"],
    ["rm -fr ./dist", "rm -fr"],
    ["rm -r -f node_modules", "rm -r -f"],
    // -r alone is a tree delete with no trash; -f only silences prompts. The
    // first is verbatim the fallback that wiped the eval's build cache uncarded.
    ["rm -r client-data/build-cache", "rm -r"],
    ["rm -R ./dist", "rm -r"],
    ["rm -rv build", "rm -r"],
    ["rm -v -r build", "rm -r"],
    ["rm --recursive build", "rm -r"],
    ["cd ws && rm -r build", "rm -r"],
    // A recursive wipe by composition. The first is verbatim what a 27B ran,
    // uncarded, after rm -rf was policy-blocked and rm -r carded (2026-09-23).
    ["find client-data/build-cache -exec rm {} + && rmdir client-data/build-cache", "find -exec rm"],
    ["find build -type f -exec unlink {} \\;", "find -exec rm"],
    ["find . -name '*.tmp' -execdir rm {} +", "find -exec rm"],
    ["find . -name '*.log' -delete", "find -delete"],
    ["find . -name '*.log' | xargs rm", "xargs rm"],
    ["find . -print0 | xargs -0 rm -f", "xargs rm"],
    ["ls *.bak | xargs -I{} unlink {}", "xargs rm"],
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
    // A loop that runs the word, hands it on, or a lookup's lookalike, still flags.
    ["for t in mkfs.ext4; do $t /dev/sdb; done", "filesystem format"],
    ["for t in mkfs.ext4; do sudo \"$t\" /dev/sdb; done", "filesystem format"],
    ["for t in mkfs.ext4; do x=$t; $x /dev/sdb; done", "filesystem format"],
    ["for t in mkfs.ext4; do echo $t | sh; done", "filesystem format"],
    ["for t in $(echo mkfs.ext4); do command -v $t; done", "filesystem format"],
    ["command -v mkfs && mkfs.ext4 /dev/sdb", "filesystem format"],
    ["find . -type f -exec rm -rf {} +", "rm -rf"],
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
    "rm -f file.txt",                  // -f on one file is not a tree
    "rm -v file.txt",
    "git rm -r --cached build",        // staged removal, undone from the index
    // Quoted text no shell runs: a commit or tag message, a search pattern
    // (both carded until 2026-10-26).
    'git commit -m "drop the rm -r fallback"',
    "git commit -qam 'git reset --hard was the wrong call'",
    'git add -A && git commit -m "fix: rm -rf no longer used" && git push',
    'git tag -a v1 --message="remove rm -rf from the docs"',
    'grep -rn "git reset --hard" docs',
    "rg -n 'rm -rf' src",
    'grep -e "git push --force" -r .',
    'Select-String -Path *.md -Pattern "Remove-Item -Recurse"',
    'git log --oneline --grep="git clean -fd"',
    'bash -c "git commit -m \'drop rm -rf\'"',
    // -d refuses a branch with unmerged commits, so it loses nothing. Verbatim
    // the cleanup that carded in Autonomous (2026-10-26).
    "cd \"/c/Users/peter/Scan Progress\" && git branch -d agent/field-agent-1-mvohb7r0",
    "git branch --delete merged",
    "git branch -d feature -v",
    "npm rm lodash",                   // an uninstall, not a delete
    "rm build-r.txt",                  // a dash inside a name is not a flag
    "find . -name '*.ts'",             // a find that lists
    "find . -type f -exec ls -l {} +", // a find that hands files to something harmless
    "find . -name '*.md' -exec grep -l TODO {} +",
    "find . -type f | xargs wc -l",    // an xargs that counts
    "cat urls.txt | xargs curl -O",
    "Remove-Item file.txt",            // single file, no tree
    "Remove-Item -Force file.txt",     // -Force alone is rm -f, not rm -rf
    "del /q file.txt",                 // /q silences the prompt; /s makes it a tree
    "rd empty-dir",                    // no /s: only an empty directory
    "Get-ChildItem -Recurse src",      // -Recurse on a READ is not a delete
    "ls -r build | Remove-Item",       // the flag belongs to the ls, not to a Remove-Item after the pipe
    "ls -la",
    "echo 'rm -rf is just text here in quotes'".replace(/rm -rf/, "remove"),
    // A lookup names a program without running it. Verbatim TB2
    // qemu-alpine-ssh (2026-10-27), carded as a filesystem format.
    "for t in mkfs.ext4 mkfs.msdos fdisk dd python3; do printf '%-12s ' \"$t\"; command -v $t || echo MISSING; done",
    "command -v mkfs.ext4",
    "which mkfs.vfat || echo missing",
    "if type mkfs >/dev/null 2>&1; then echo ok; fi",
  ];

  for (const cmd of benign) {
    it(`does not flag: ${cmd}`, () => {
      expect(isDestructiveCommand("bash", { command: cmd })).toBeNull();
    });
  }

  it("applies to every tool that runs a shell command, not to the rest", () => {
    expect(isDestructiveCommand("process_start", { command: "rm -rf /x" })).toBe("rm -rf");
    expect(isDestructiveCommand("app_serve_backend", { command: "rm -rf /x" })).toBe("rm -rf");
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
