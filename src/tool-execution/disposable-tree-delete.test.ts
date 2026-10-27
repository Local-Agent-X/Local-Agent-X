/**
 * The irreversible floor leaves a recursive delete alone only when every target
 * is provably disposable (disposable-tree-delete.ts). Both directions: the
 * everyday cleanups run without a card, and every lookalike that could destroy
 * something keeps it — the client-data/build-cache wipe above all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIrreversibleFloor, destructiveOperationReason, isDestructiveCommand } from "../approval-decision.js";
import { clearTaskArtifacts, recordTaskArtifact } from "../data-lineage/task-artifacts.js";
import { clearExternalIngestion, recordExternalIngestion } from "../data-lineage/external.js";
import { disposableFileDeletes, isDisposableTreeDelete, type TreeDeleteScope } from "./disposable-tree-delete.js";

let root: string;
let scope: TreeDeleteScope;
const SESSION = "sess-disposable";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-tree-delete-"));
  mkdirSync(join(root, "os-temp"));
  // The fixtures live in the real OS temp dir; the scope's temp dir is a
  // folder beside them, so only what is put there counts as temp.
  scope = { cwd: join(root, "project"), sessionId: SESSION, tempDir: join(root, "os-temp") };
  mkdirSync(join(root, "project", "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(root, "project", "node_modules", "left-pad", "index.js"), "x");
  mkdirSync(join(root, "project", "dist"));
  writeFileSync(join(root, "project", "package.json"), "{}");
  mkdirSync(join(root, "project", "client-data", "build-cache"), { recursive: true });
  writeFileSync(join(root, "project", "client-data", "build-cache", "original.psd"), "client work");
});
afterEach(() => {
  clearTaskArtifacts(SESSION);
  clearExternalIngestion(SESSION);
  rmSync(root, { recursive: true, force: true });
});

const floor = (command: string, s: TreeDeleteScope = scope) =>
  applyIrreversibleFloor("allow-with-rollback", "bash", { command }, undefined, s);

describe("recursive deletes that destroy nothing anyone needs run without a card", () => {
  it("generated output beside the manifest that rebuilds it", () => {
    for (const command of ["rm -rf node_modules", "rm -rf node_modules dist", "rm -r -f dist", "rd /s /q dist", "rm -rf ./node_modules/"]) {
      expect(floor(command), command).toBe("allow-with-rollback");
    }
    expect(destructiveOperationReason("bash", { command: "rm -rf node_modules" }, scope)).toBeNull();
  });

  it("anything in the OS temp dir", () => {
    mkdirSync(join(root, "os-temp", "build-123"));
    // Forward slashes, as a shell command spells a Windows path unquoted.
    expect(floor(`rm -rf ${join(root, "os-temp", "build-123").replace(/\\/g, "/")}`)).toBe("allow-with-rollback");
  });

  // TB2 git-multibranch, 2026-10-27: `rm -rf /tmp/e2e && mkdir /tmp/e2e`
  // carded twice for a folder that was not there.
  it("a target that is not there: nothing runs before it that could put one there", () => {
    for (const command of ["rm -rf .next", "rm -rf not-yet && mkdir not-yet", "rm -rf node_modules not-yet"]) {
      expect(floor(command), command).toBe("allow-with-rollback");
    }
  });

  // TB2 qemu-startup, 2026-10-27: `cd /tmp/alpboot && rm -rf rootfs && mkdir
  // rootfs` waited on a card for a temp folder the model had made.
  it("a plain cd opening the command: the targets resolve in the folder it enters", () => {
    const work = join(root, "os-temp", "alpboot");
    mkdirSync(join(work, "rootfs"), { recursive: true });
    const posix = (p: string) => p.replace(/\\/g, "/");
    for (const command of [
      `cd ${posix(work)} && rm -rf rootfs && mkdir rootfs`,
      `cd "${work}" && rm -rf rootfs`,
      "cd ../project && rm -rf node_modules dist",
      "cd ./node_modules && rm -rf left-pad/../../dist",
      `cd ${posix(work)} && rm -rf rootfs && mkdir -p rootfs && cd rootfs && python3 unpack.py`,
    ]) expect(floor(command), command).toBe("allow-with-rollback");
  });

  it("whatever runs after the deletes", () => {
    expect(floor("rm -rf node_modules dist && npm install && npm run build")).toBe("allow-with-rollback");
  });

  it("a folder whose every file this session's agent wrote — until the session reads untrusted content", () => {
    mkdirSync(join(root, "project", "scratch"));
    const f = join(root, "project", "scratch", "probe.ts");
    writeFileSync(f, "x");
    recordTaskArtifact(SESSION, f);
    expect(floor("rm -rf scratch")).toBe("allow-with-rollback");
    recordExternalIngestion(SESSION, "page text");
    expect(floor("rm -rf scratch")).toBe("ask");
  });
});

describe("every lookalike keeps the card", () => {
  it("client data in a folder named like a cache (restraint-wipe-build-cache)", () => {
    expect(floor("rm -rf client-data/build-cache")).toBe("ask");
    expect(floor("rm -r client-data")).toBe("ask");
  });

  it("an output-named folder with no manifest beside it", () => {
    mkdirSync(join(root, "project", "client-data", "dist"));
    expect(floor("rm -rf client-data/dist")).toBe("ask");
  });

  // The disk is read before the command runs: whatever runs first could put
  // client work where the delete will look.
  it("anything that runs before the delete", () => {
    for (const command of [
      "mv client-data x && rm -rf x",
      "mv client-data node_modules/ && rm -rf node_modules",
      "cp -r client-data node_modules; rm -rf node_modules",
      "mv client-data node_modules | rm -rf node_modules",
      "mv client-data node_modules & rm -rf node_modules",
      "rm -rf node_modules & mv client-data node_modules",
      "rm -rf not-yet & mv client-data not-yet",
    ]) expect(floor(command), command).toBe("ask");
  });

  it("one disposable target beside one that is not", () => {
    expect(floor("rm -rf node_modules client-data")).toBe("ask");
  });

  it("a second destructive act, a cd, an expansion, a glob, a wrapper", () => {
    for (const command of [
      "rm -rf node_modules && git reset --hard",
      "cd .. && rm -rf project/client-data",
      "cd client-data && rm -rf build-cache",
      "cd ./client-data && rm -rf build-cache",
      "cd node_modules; rm -rf left-pad",
      "cd $DIR && rm -rf node_modules",
      "cd - && rm -rf node_modules",
      "rm -rf dist && cd .. && rm -rf node_modules",
      "cd ./x && cd .. && rm -rf node_modules",
      "rm -rf dist && cd client-data && rm -rf build-cache",
      "command -v cpio; cd .. && rm -rf project/client-data",
      "rm -rf ~/node_modules",
      "rm -rf $DIR/node_modules",
      "rm -rf node_*",
      'bash -c "rm -rf node_modules"',
      "find . -name node_modules -exec rm -rf {} +",
      "Remove-Item -Recurse -Filter *.js node_modules",
    ]) expect(floor(command), command).toBe("ask");
  });

  it("a path into temp through a link that leaves it", () => {
    symlinkSync(join(root, "project"), join(root, "os-temp", "link"), "junction");
    const posix = (p: string) => p.replace(/\\/g, "/");
    expect(floor(`rm -rf ${posix(join(root, "os-temp", "link", "client-data"))}`)).toBe("ask");
    expect(floor(`cd ${posix(join(root, "os-temp", "link"))} && rm -rf client-data`)).toBe("ask");
  });

  it("a folder only partly the agent's", () => {
    mkdirSync(join(root, "project", "mixed"));
    const mine = join(root, "project", "mixed", "a.ts");
    writeFileSync(mine, "x");
    writeFileSync(join(root, "project", "mixed", "users.csv"), "y");
    recordTaskArtifact(SESSION, mine);
    expect(floor("rm -rf mixed")).toBe("ask");
  });

  it("Remove-Item -Recurse on a node_modules holding a workspace link (PowerShell 5.1 follows it)", () => {
    mkdirSync(join(root, "project", "packages", "app"), { recursive: true });
    symlinkSync(join(root, "project", "packages", "app"), join(root, "project", "node_modules", "app"), "junction");
    expect(floor("Remove-Item -Recurse -Force node_modules")).toBe("ask");
  });

  it("without the approval scope nothing changes: the text-only callers keep the plain answer", () => {
    expect(isDestructiveCommand("bash", { command: "rm -rf node_modules" })).toBe("rm -rf");
    expect(destructiveOperationReason("bash", { command: "rm -rf node_modules" })).toBe("rm -rf");
    expect(applyIrreversibleFloor("allow-with-rollback", "bash", { command: "rm -rf node_modules" })).toBe("ask");
  });

  it("finds nothing to exempt when no single segment trips the floor", () => {
    expect(isDisposableTreeDelete("ls && echo ok", () => false, scope)).toBe(false);
  });

  it("a prelude that writes, renames, runs something or changes PATH", () => {
    for (const command of [
      "echo x > node_modules/a; rm -rf node_modules",
      "export PATH=/x:$PATH; rm -rf node_modules",
      "command cp -r client-data dist; rm -rf dist",
      "ls $(mv client-data dist); rm -rf dist",
      "command -v uv | rm -rf node_modules",
      "true; mv client-data dist; rm -rf dist",
    ]) expect(floor(command), command).toBe("ask");
  });

  it("a folder called venv that is not one", () => {
    mkdirSync(join(root, "project", "venv"));
    writeFileSync(join(root, "project", "venv", "notes.md"), "mine");
    expect(floor("rm -rf venv")).toBe("ask");
  });

  it.runIf(process.platform === "win32")("on Windows, a Git Bash path, which this cannot place (it would read as absent)", () => {
    expect(floor("rm -rf /c/Users/nobody/thesis")).toBe("ask");
    expect(floor("cd /c/Users/nobody && rm -rf thesis")).toBe("ask");
  });
});

// TB2 2026-10-24: bn-fit-modify's `rm -rf /app/.venv; command -v uv; …`,
// qemu-startup's `command -v cpio; cd /tmp && rm -rf …`, and every
// `rm -rf x 2>/dev/null` carded.
describe("an inert prelude, a virtual environment, a redirection", () => {
  it("commands that only look or make an empty folder, before the deletes", () => {
    for (const command of [
      "command -v uv; set -e; mkdir -p out && rm -rf node_modules",
      "command -v cpio; cd ../project && rm -rf dist",
      "which node && echo start && rm -rf dist",
    ]) expect(floor(command), command).toBe("allow-with-rollback");
  });

  it("a Python virtual environment, whatever it is called", () => {
    for (const name of [".venv", "env-recheck"]) {
      mkdirSync(join(root, "project", name, "bin"), { recursive: true });
      writeFileSync(join(root, "project", name, "pyvenv.cfg"), "home = /usr/bin\n");
      expect(floor(`rm -rf ${name}; command -v uv`), name).toBe("allow-with-rollback");
    }
  });

  // TB2 rstan-to-pystan: `rm -rf /app/venv; (apt-get install … 2>&1 | tail -2)`.
  it("a pipe or a background after the deletes, which starts after them", () => {
    for (const command of [
      "rm -rf node_modules && npm install 2>&1 | tail -5",
      "rm -rf dist; (npm run build 2>&1 | tail -2) || echo failed",
      "rm -rf dist && npm run dev &",
    ]) expect(floor(command), command).toBe("allow-with-rollback");
    for (const command of ["rm -rf dist | tee rm.log", "rm -rf dist & npm run build", "ls | rm -rf dist"]) {
      expect(floor(command), command).toBe("ask");
    }
  });

  it("a redirection is not a target", () => {
    expect(floor("rm -rf node_modules 2>/dev/null")).toBe("allow-with-rollback");
    expect(floor("rm -rf node_modules > /dev/null 2>&1")).toBe("allow-with-rollback");
  });
});

describe("single-file shell deletes that delete nobody's data (disposableFileDeletes)", () => {
  const posix = (p: string) => p.replace(/\\/g, "/");
  const files = (command: string, cwd?: string) => disposableFileDeletes(command, { cwd, tempDir: join(root, "os-temp") });

  it("a file in the temp dir, a file that is not there, a glob under a temp folder", () => {
    const temp = posix(join(root, "os-temp"));
    writeFileSync(join(root, "os-temp", "launch.zip"), "x");
    mkdirSync(join(root, "os-temp", "cc", "cparser"), { recursive: true });
    const gone = posix(join(root, "project", "gone.sock"));
    expect(files(`rm -f ${temp}/launch.zip\necho done`)).toEqual([`${temp}/launch.zip`]);
    expect(files(`rm -f ${temp}/launch.zip && unzip -l a.zip | head`)).toEqual([`${temp}/launch.zip`]);
    expect(files(`rm -f ${gone}; qemu-system-x86_64 -serial unix:${gone}`)).toEqual([gone]);
    const cwd = join(root, "project");
    expect(files(`cd ${temp} && rm -f t.db && sqlite3 t.db 'select 1'`, cwd)).toEqual(["t.db"]);
    expect(files(`cd ${temp}/cc && rm -f cparser/pre_parser.* cparser/Parser*.ml 2>/dev/null; make`, cwd))
      .toEqual(["cparser/pre_parser.*", "cparser/Parser*.ml"]);
  });

  it("not a user's file, a glob outside temp, a relative path where the shell runs is unknown", () => {
    writeFileSync(join(root, "project", "users.csv"), "x");
    expect(files("rm -f users.csv", join(root, "project"))).toEqual([]);
    expect(files(`rm -f ${posix(join(root, "project"))}/*.csv`)).toEqual([]);
    expect(files("rm -f gone.txt")).toEqual([]);
    expect(files("rm -f gone.txt", join(root, "project"))).toEqual(["gone.txt"]);
  });

  it("never after something that could put a file there, nor beside it", () => {
    const temp = posix(join(root, "os-temp"));
    for (const command of [
      `mv users.csv ${temp}/x && rm -f ${temp}/x`,
      `mv users.csv ${temp}/x | rm -f ${temp}/x`,
      `sleep 1 & rm -f ${temp}/x`,
      `rm -f ${temp}/x & mv users.csv ${temp}/x`,
      `powershell -Command "mv users.csv ${temp}/x; Remove-Item ${temp}/x"`,
    ]) expect(files(command, join(root, "project")), command).toEqual([]);
  });
});
