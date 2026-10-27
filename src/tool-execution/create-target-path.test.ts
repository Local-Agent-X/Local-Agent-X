/**
 * shellCreateTargets: the files a shell command's own truncating writes create,
 * which run-sandboxed.ts enrolls as the agent's when they were absent before.
 * Both directions: the everyday logs and outputs are found, and every shape
 * where the file could hold someone else's bytes, or sit somewhere this cannot
 * place, is left out.
 */
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { shellCreateTargets } from "./create-target-path.js";

const cwd = resolve("/work/proj");
const at = (p: string) => join(cwd, p);

describe("shellCreateTargets finds what the command's own writes create", () => {
  it("truncating redirections, nested shell bodies and tee", () => {
    expect(shellCreateTargets("./setup.sh > setup.log 2>&1", cwd)).toEqual([at("setup.log")]);
    expect(shellCreateTargets("make &> build.log", cwd)).toEqual([at("build.log")]);
    expect(shellCreateTargets("make >&out.txt", cwd)).toEqual([at("out.txt")]);
    expect(shellCreateTargets("echo hi > a.txt && echo there > b.txt", cwd)).toEqual([at("a.txt"), at("b.txt")]);
    expect(shellCreateTargets('bash -c "ls > list.txt"', cwd)).toEqual([at("list.txt")]);
    expect(shellCreateTargets("npm test | tee test.log", cwd)).toEqual([at("test.log")]);
    expect(shellCreateTargets("echo x > /tmp/probe.txt", cwd)).toEqual([resolve("/tmp/probe.txt")]);
  });

  it("a command that only reads or prints the file does not stop it counting", () => {
    expect(shellCreateTargets("expect setup.exp > /app/vm/console.log 2>&1; sleep 3; cat /app/vm/console.log", cwd))
      .toEqual([resolve("/app/vm/console.log")]);
    expect(shellCreateTargets("make > build.log; tail -5 build.log; grep -c error build.log", cwd)).toEqual([at("build.log")]);
  });
});

describe("shellCreateTargets leaves out what it cannot prove is the command's output", () => {
  it("appends, touch, tee with flags, fds and devices", () => {
    for (const command of [
      "echo x >> setup.log",
      "make &>> build.log",
      "touch marker",
      "npm test | tee -a test.log",
      "make 2>&1",
      "make >&-",
      "make > /dev/null",
    ]) expect(shellCreateTargets(command, cwd), command).toEqual([]);
  });

  it("a path another command in the line also names", () => {
    expect(shellCreateTargets("mv users.csv new.csv && cat new.csv > new.csv", cwd)).toEqual([]);
    expect(shellCreateTargets("cp users.csv out.csv; sort users.csv > out.csv", cwd)).toEqual([]);
  });

  it("a relative path after a cd, an expansion, a glob, a brace, a tilde", () => {
    for (const command of [
      "cd out && echo x > a.txt",
      "echo x > $OUT",
      "echo x > out-*.txt",
      "echo x > {a,b}.txt",
      "echo x > ~/a.txt",
    ]) expect(shellCreateTargets(command, cwd), command).toEqual([]);
    expect(shellCreateTargets("cd out && echo x > /tmp/a.txt", cwd)).toEqual([resolve("/tmp/a.txt")]);
    expect(shellCreateTargets("cd ../a && cd ../b && echo x > a.txt", cwd)).toEqual([]);
  });
});

// TB2 extract-elf, 2026-10-24: `cd /app && rm -f out.json && node extract.js
// > out.json` wrote the agent's output, which a later `rm -f out.json` was
// then refused for as a user's file.
describe("shellCreateTargets follows a leading cd and a remove before the write", () => {
  it("resolves in the folder a leading cd enters", () => {
    const app = resolve("/app");
    const spelled = app.replace(/\\/g, "/");
    expect(shellCreateTargets(`cd ${spelled} && rm -f out.json && node extract.js ${spelled}/a.out > out.json 2>err.txt`, cwd))
      .toEqual([join(app, "out.json"), join(app, "err.txt")]);
    expect(shellCreateTargets("command -v node; cd ./build && make > build.log", cwd)).toEqual([join(cwd, "build", "build.log")]);
  });
});
