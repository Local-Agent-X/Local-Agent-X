// An approval card says what the call would do, in plain words from the
// gate's own parse, and carries the whole command: never a cut-off command
// with the dangerous part past the cut.
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addApprovalReason, andList, approvalCardText, destructiveExplanation } from "./approval-card-text.js";
import { argsLine } from "./approval-context.js";
import { destructiveOperationReason } from "../approval-decision.js";

const dir = join(tmpdir(), "lax-card-text");
const shell = (command: string, extra: Record<string, unknown> = {}) => ({ command, _cwd: dir, ...extra });

/** The card for a bash command the gate found irreversible. */
function card(command: string, policyReason?: string) {
  const args = shell(command);
  const destructive = destructiveOperationReason("bash", args);
  return approvalCardText({ toolName: "bash", args, destructive, policyReason, line: `Run command: "${command.slice(0, 150)}"` });
}

describe("what an irreversible shell command would do, in plain words", () => {
  it("a delete names what it removes and the folder it removes it from", () => {
    const text = destructiveExplanation("bash", shell("rm -rf package three-0.170.0.tgz"), "rm -rf", dir);
    expect(text).toBe(`Permanently deletes "package" and "three-0.170.0.tgz" in ${dir}. Deleted files do not go to the recycle bin.`);
  });

  it("a delete after a cd it cannot place says so instead of guessing the folder", () => {
    const text = destructiveExplanation("bash", shell('cd "$W/app" && rm -rf package'), "rm -rf", dir);
    expect(text).toContain('Permanently deletes "package" in a folder the command changes into.');
  });

  it("a cd through a name the line assigns is placed, so the folder is named", () => {
    const posix = dir.replace(/\\/g, "/");
    const text = destructiveExplanation("bash", shell(`W="${posix}"; mkdir -p "$W/app" && cd "$W/app" && rm -rf package`), "rm -rf", dir);
    expect(text).toContain(`Permanently deletes "package" in ${join(dir, "app")}.`);
  });

  it("a composed delete says what decides the files", () => {
    expect(destructiveExplanation("bash", shell("find build -name '*.o' -delete"), "find -delete", dir))
      .toContain('Deletes the files find selects under "build"');
    expect(destructiveExplanation("bash", shell("git clean -fdx"), "git clean -f", dir))
      .toContain('Deletes every untracked file under "."');
  });

  it("each non-delete pattern has its own sentence", () => {
    const commands: Array<[string, RegExp]> = [
      ["git push --force origin main", /Overwrites the branch's history on the remote/],
      ["git push origin --delete feature", /Deletes a branch from the remote/],
      ["git reset --hard HEAD~3", /Throws away every uncommitted change/],
      ["git branch -D feature", /Deletes a branch whose commits may exist nowhere else/],
      ["git filter-branch --all", /Rewrites the repository's history/],
      ["dd if=x.img of=/dev/sdb", /Writes raw data straight onto a disk/],
      ["mkfs.ext4 /dev/sdb1", /Formats a disk/],
    ];
    for (const [command, sentence] of commands) {
      const reason = destructiveOperationReason("bash", shell(command));
      expect(reason, command).not.toBeNull();
      expect(destructiveExplanation("bash", shell(command), reason!, dir), command).toMatch(sentence);
    }
  });

  it("a destructive tool keeps the gate's reason; its own describeCall is the line", () => {
    const reason = "destructive tool (delete_file) — irreversible, confirm before running";
    expect(destructiveExplanation("delete_file", { path: "a.txt" }, reason)).toBe(reason);
  });
});

describe("the card for a shell ask", () => {
  // The command behind the 2026-10-31 card: 330 characters, the rm -rf past
  // the 150 the line showed.
  const long = 'W="/c/Users/me/Documents/Local Agent X/workspace/apps"; ls -a "$W/flappy-butt" "$W/simon-game"; mkdir -p "$W/disneyland-adventure" && cd "$W/disneyland-adventure" && npm pack three@0.170.0 --silent 2>&1 | tail -1 && tar -xzf three-0.170.0.tgz package/build/three.module.js && mv package/build/three.module.js ./three.module.js && rm -rf package three-0.170.0.tgz && ls -la';

  it("carries the whole command in its preview, with the folder it runs in", () => {
    const { context, preview } = card(long);
    expect(preview).toMatchObject({ kind: "shell", cmd: long, cwd: dir });
    expect(context).not.toContain("Run command");
  });

  it("an irreversible one leads with what it would delete, not the command", () => {
    const { context, preview } = card(long);
    // Where the folder is named depends on the box (Git Bash places `/c/…`); what is deleted does not.
    expect(context).toMatch(/^⚠ Cannot be undone — Permanently deletes "package" and "three-0.170.0.tgz" in .+\. Deleted files do not go to the recycle bin\. \(rm -rf\)$/);
    expect(preview).toMatchObject({ explanation: expect.stringContaining('"package" and "three-0.170.0.tgz"') });
  });

  it("a policy ask says the gate's own reason; a profile ask says the profile asked", () => {
    expect(card("npm install left-pad", "Shell commands require approval in workspace mode").context)
      .toBe("Shell commands require approval in workspace mode.");
    expect(card("npm install left-pad").context).toBe("Your security profile asks before a command like this runs.");
  });

  it("a tool that runs no shell keeps its own line and gets no preview", () => {
    const out = approvalCardText({ toolName: "write", args: { path: "a.md" }, destructive: null, line: "Create file: a.md" });
    expect(out).toEqual({ context: "Create file: a.md", preview: undefined });
  });

  it("a publish ask keeps its review on the card, with the irreversible headline when it is one", () => {
    const review = { context: "Pre-publish review: GREEN.", preview: { kind: "publish-review" as const, status: "GREEN" as const, command: "git push --force", summary: "ok", findings: [] } };
    const args = shell("git push --force origin main");
    const out = approvalCardText({ toolName: "bash", args, destructive: "git force-push", line: "", review });
    expect(out.context).toMatch(/^⚠ Cannot be undone — Overwrites the branch's history on the remote.*\(git force-push\) Pre-publish review: GREEN\.$/);
    expect(out.preview).toBe(review.preview);
  });
});

// A gate's reason is the card's sentence. The raw `name: {json}` line used to
// follow it, cut at 80 characters mid-word, repeating the args the card lists
// below (2026-11-10).
describe("the card for a gate's reason", () => {
  const args = { to: "tesa@example.com", subject: "Thank you", body: "Hi" };
  const reason = "Send text from an email you read to tesa@example.com? You haven't named that address in this chat.";

  it("is the reason alone when the tool has no description of its own", () => {
    const out = approvalCardText({ toolName: "email_send", args, destructive: null, policyReason: reason, line: argsLine("email_send", args) });
    expect(out.context).toBe(reason);
    expect(out.context).not.toContain("{");
  });

  it("keeps a tool's own description of the call after the reason", () => {
    const out = approvalCardText({ toolName: "write", args: { path: "a.txt" }, destructive: null, policyReason: "The agent wants to change a.txt", line: "Write a.txt" });
    expect(out.context).toBe("The agent wants to change a.txt. Write a.txt");
  });
});

describe("several gates asking about one call", () => {
  it("reads as sentences, each once", () => {
    const ctx: { policyApprovalReason?: string } = { policyApprovalReason: "a policy rule asks" };
    addApprovalReason(ctx, "The agent wants to change ~/.bashrc, which runs commands. Approve it only if you asked for this change.");
    addApprovalReason(ctx, "The agent wants to change ~/.bashrc, which runs commands. Approve it only if you asked for this change.");
    expect(ctx.policyApprovalReason).toBe("a policy rule asks. The agent wants to change ~/.bashrc, which runs commands. Approve it only if you asked for this change.");
  });

  it("names several things the way a sentence does", () => {
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b"])).toBe("a and b");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
  });
});
