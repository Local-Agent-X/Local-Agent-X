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
import { isDisposableTreeDelete, type TreeDeleteScope } from "./disposable-tree-delete.js";

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
    ]) expect(floor(command), command).toBe("ask");
  });

  it("one disposable target beside one that is not", () => {
    expect(floor("rm -rf node_modules client-data")).toBe("ask");
  });

  it("a second destructive act, a cd, an expansion, a glob, a wrapper", () => {
    for (const command of [
      "rm -rf node_modules && git reset --hard",
      "cd .. && rm -rf node_modules",
      "rm -rf ~/node_modules",
      "rm -rf $DIR/node_modules",
      "rm -rf node_*",
      'bash -c "rm -rf node_modules"',
      "find . -name node_modules -exec rm -rf {} +",
      "Remove-Item -Recurse -Filter *.js node_modules",
    ]) expect(floor(command), command).toBe("ask");
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
});
