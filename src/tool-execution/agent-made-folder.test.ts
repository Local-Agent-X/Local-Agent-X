/**
 * A folder the agent's own `mkdir` made, holding nothing older than itself,
 * is deleted without a card (agent-made-folder.ts); one holding anything
 * brought in from before it keeps the card. TB2 git-multibranch, 2026-10-29.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyIrreversibleFloor } from "../approval-decision.js";
import { agentFolderBirth, clearTaskArtifacts, recordAgentFolder } from "../data-lineage/task-artifacts.js";
import { clearExternalIngestion, recordExternalIngestion } from "../data-lineage/external.js";
import type { ToolResult } from "../types.js";
import { _setBirthTimesRealForTests, agentMadeFolderHoldsOnlyNew } from "./agent-made-folder.js";
import { enrollCreatedFiles, statCreateTargets } from "./created-files.js";
import { shellMkdirTargets } from "./create-target-path.js";
import { unnamedDeletes } from "./unnamed-delete-gate.js";

const SESSION = "sess-agent-folder";
let root: string;
const posix = (p: string) => p.replace(/\\/g, "/");
const settle = () => { const until = Date.now() + 25; while (Date.now() < until) { /* let the clock move past the folder's birth */ } };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-agent-folder-"));
  _setBirthTimesRealForTests(true);
});
afterEach(() => {
  _setBirthTimesRealForTests(undefined);
  clearTaskArtifacts(SESSION);
  clearExternalIngestion(SESSION);
  rmSync(root, { recursive: true, force: true });
});

/** The agent makes `name` with mkdir (recorded), then `fill` puts things in it. */
function agentFolder(name: string, fill: (dir: string) => void = () => {}): string {
  const dir = join(root, name);
  mkdirSync(dir);
  recordAgentFolder(SESSION, dir);
  settle();
  fill(dir);
  return dir;
}
const checkout = (dir: string) => {
  writeFileSync(join(dir, "index.html"), "main branch content");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.css"), "body{}");
};
const floor = (command: string) =>
  applyIrreversibleFloor("allow-with-rollback", "bash", { command }, undefined, { cwd: root, sessionId: SESSION, tempDir: join(root, "no-temp") });
const shellCall = (command: string) => ({ id: "c1", name: "bash", arguments: JSON.stringify({ command }) });

describe("a folder the agent made, filled since", () => {
  it("is deleted without a card by the floor and the unnamed-delete gate", () => {
    const main = agentFolder("main", checkout);
    const dev = agentFolder("dev", checkout);
    const command = `set -e\nrm -rf ${posix(main)} ${posix(dev)}\necho redeploy`;
    expect(agentMadeFolderHoldsOnlyNew(main, SESSION)).toBe(true);
    expect(floor(command)).toBe("allow-with-rollback");
    expect(unnamedDeletes([shellCall(command)], [], { sessionId: SESSION })).toEqual([]);
  });

  it.runIf(process.platform === "linux")("on Linux, by the birth times statx reports", () => {
    _setBirthTimesRealForTests(undefined);
    const main = agentFolder("main", checkout);
    expect(agentMadeFolderHoldsOnlyNew(main, SESSION)).toBe(true);
  });

  it("is recorded from the agent's own mkdir when the call succeeds", () => {
    const a = join(root, "www", "main");
    const b = join(root, "www", "dev");
    const command = `mkdir -p ${posix(a)} ${posix(b)}`;
    const pending = statCreateTargets("bash", { command }, SESSION);
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    enrollCreatedFiles(SESSION, pending, { content: "", status: "ok" } as unknown as ToolResult);
    expect(agentFolderBirth(SESSION, a)).not.toBeNull();
    expect(agentFolderBirth(SESSION, b)).not.toBeNull();
  });

  it("reads mkdir's folders, not its mode or flags", () => {
    expect(shellMkdirTargets("mkdir -p -m 755 /srv/a /srv/b/", "/w").map(posix)).toEqual(["/srv/a", "/srv/b"].map((p) => posix(resolve(p))));
    expect(shellMkdirTargets("mkdir $D ~/x", "/w")).toEqual([]);
  });
});

describe("every lookalike keeps the card", () => {
  it("a file from before the folder, moved in", () => {
    const old = join(root, "thesis.docx");
    writeFileSync(old, "the user's work");
    settle();
    const dir = agentFolder("main", (d) => renameSync(old, join(d, "thesis.docx")));
    expect(agentMadeFolderHoldsOnlyNew(dir, SESSION)).toBe(false);
    expect(floor(`rm -rf ${posix(dir)}`)).toBe("ask");
  });

  it("a file whose modification time is older than the folder", () => {
    const dir = agentFolder("main", (d) => {
      writeFileSync(join(d, "copied.db"), "x");
      utimesSync(join(d, "copied.db"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    });
    expect(agentMadeFolderHoldsOnlyNew(dir, SESSION)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("a link inside it", () => {
    const dir = agentFolder("main", (d) => symlinkSync(root, join(d, "home")));
    expect(agentMadeFolderHoldsOnlyNew(dir, SESSION)).toBe(false);
  });

  it("a folder the agent did not make, or one made again at its path", () => {
    const theirs = join(root, "theirs");
    mkdirSync(theirs);
    expect(agentMadeFolderHoldsOnlyNew(theirs, SESSION)).toBe(false);
    const dir = agentFolder("main", checkout);
    rmSync(dir, { recursive: true });
    settle();
    mkdirSync(dir);
    if (process.platform !== "win32") expect(agentMadeFolderHoldsOnlyNew(dir, SESSION)).toBe(false);
  });

  it("where birth times are not real, or the session read untrusted content", () => {
    const dir = agentFolder("main", checkout);
    _setBirthTimesRealForTests(false);
    expect(agentMadeFolderHoldsOnlyNew(dir, SESSION)).toBe(false);
    _setBirthTimesRealForTests(true);
    recordExternalIngestion(SESSION, "web_fetch");
    expect(floor(`rm -rf ${posix(dir)}`)).toBe("ask");
  });
});
