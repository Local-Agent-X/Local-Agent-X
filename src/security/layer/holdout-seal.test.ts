// The holdout seal: no tool call reads, searches or changes a build's sealed
// scenarios, in any file-access mode and from any caller. Each case is a way an
// agent could reach the suite: a file tool, a search from above it, a shell
// command by absolute path, by `~`, after a cd, or a tree walk.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityLayer } from "./layer-core.js";
import { holdoutShellRefusal } from "./holdout-seal.js";
import type { FileAccessMode } from "./types.js";

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "lax-holdout-")));
const DATA = join(BASE, ".lax");
const SUITE = join(DATA, "holdout", "petbook");
const WORKSPACE = join(BASE, "workspace");
const PROJECT = join(WORKSPACE, "apps", "petbook");
const prior = process.env.LAX_DATA_DIR;
beforeAll(() => {
  process.env.LAX_DATA_DIR = DATA;
  mkdirSync(SUITE, { recursive: true });
  mkdirSync(join(PROJECT, "spec"), { recursive: true });
  writeFileSync(join(SUITE, "first-pet.md"), "A visitor adds a pet...");
});
afterAll(() => {
  if (prior === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prior;
  rmSync(BASE, { recursive: true, force: true });
});

const MODES: FileAccessMode[] = ["workspace", "common", "unrestricted"];
const q = (p: string) => JSON.stringify(p);

describe("holdout seal — file tools", () => {
  for (const mode of MODES) {
    it(`${mode}: read, write, edit and a search from above the suite are refused`, () => {
      const sec = new SecurityLayer(WORKSPACE, mode);
      const call = (toolName: string, args: Record<string, unknown>, callContext?: "delegated") =>
        sec.evaluate({ toolName, args, sessionId: "s", ...(callContext ? { callContext } : {}) });
      const scenario = join(SUITE, "first-pet.md");
      for (const decision of [
        call("read", { path: scenario }),
        call("write", { path: join(SUITE, "new.md"), content: "x" }),
        call("edit", { path: scenario, old_string: "A", new_string: "B" }),
        call("grep", { pattern: "pet", path: DATA }),
        call("glob", { pattern: "**/*.md", path: BASE }),
        call("read", { path: scenario }, "delegated"),
      ]) {
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain("sealed test suite");
      }
    });
  }

  it("leaves the project and its spec alone", () => {
    const sec = new SecurityLayer(WORKSPACE, "unrestricted");
    const read = sec.evaluate({ toolName: "read", args: { path: join(PROJECT, "spec", "product.md") }, sessionId: "s" });
    expect(read.reason ?? "").not.toContain("sealed test suite");
    const search = sec.evaluate({ toolName: "grep", args: { pattern: "x", path: PROJECT }, sessionId: "s" });
    expect(search.reason ?? "").not.toContain("sealed test suite");
  });
});

describe("holdout seal — shell", () => {
  const refused = (command: string, base = PROJECT) => holdoutShellRefusal(command, base) !== null;

  it("refuses the suite named by absolute path, by ~/.lax and by $HOME", () => {
    expect(refused(`cat ${q(join(SUITE, "first-pet.md"))}`)).toBe(true);
    expect(refused("cat ~/.lax/holdout/petbook/first-pet.md")).toBe(true);
    expect(refused('cat "$HOME/.lax/holdout/petbook/first-pet.md"')).toBe(true);
    expect(refused("bash -c 'head -5 ~/.lax/holdout/petbook/*.md'")).toBe(true);
  });

  it("refuses a relative read after a cd into the suite, or from a folder it cannot place", () => {
    expect(refused(`cd ${q(SUITE)} && cat first-pet.md`)).toBe(true);
    expect(refused(`cd ${q(DATA)} && cat holdout/petbook/first-pet.md`)).toBe(true);
    expect(refused("cd ~/.lax && cat holdout/petbook/first-pet.md")).toBe(true);
  });

  it("refuses a tree walk or copy from a folder above the suite", () => {
    expect(refused(`grep -r pet ${q(BASE)}`)).toBe(true);
    expect(refused(`cd ${q(DATA)} && rg pet`)).toBe(true);
    expect(refused(`cp -r ${q(DATA)} /tmp/out`)).toBe(true);
    expect(refused(`find ${q(BASE)} -name "*.md"`)).toBe(true);
  });

  it("lets ordinary work through, including a copy whose destination is above the suite", () => {
    expect(refused("npm test")).toBe(false);
    expect(refused("grep -r TODO src")).toBe(false);
    expect(refused(`cp notes.md ${q(BASE)}`)).toBe(false);
    expect(refused(`cat ${q(join(PROJECT, "spec", "product.md"))}`)).toBe(false);
  });

  it("is applied to bash and process_start by the security layer in every mode", () => {
    for (const mode of MODES) {
      const sec = new SecurityLayer(WORKSPACE, mode);
      const bash = sec.evaluate({ toolName: "bash", args: { command: "cat ~/.lax/holdout/petbook/first-pet.md" }, sessionId: "s" });
      expect(bash.allowed).toBe(false);
      const proc = sec.evaluate({ toolName: "process_start", args: { command: "node x.js", cwd: SUITE }, sessionId: "s" });
      expect(proc.allowed).toBe(false);
    }
  });
});
