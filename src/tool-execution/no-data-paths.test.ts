/**
 * What a delete may remove without losing anyone's data, proven from the disk
 * (no-data-paths.ts), and the lookalikes that keep their card.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globHoldsNoData, holdsNoData } from "./no-data-paths.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lax-no-data-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const noData = (path: string, trailingSep = false) => holdsNoData(path, lstatSync(path), trailingSep);
const SHA = "6b4c75c9f0a1d2e3b4c5d6e7f8091a2b3c4d5e6f";

describe("holdsNoData", () => {
  it("a link, unless written with a trailing separator that reaches through it", () => {
    mkdirSync(join(root, "sites-available"));
    symlinkSync(join(root, "sites-available"), join(root, "default"), "junction");
    expect(noData(join(root, "default"))).toBe(true);
    expect(noData(join(root, "default"), true)).toBe(false);
  });

  it("a pid file holds a process id; a pid-named file holding anything else is data", () => {
    writeFileSync(join(root, "qemu.pid"), "4242\n");
    writeFileSync(join(root, "notes.pid"), "call the client back");
    writeFileSync(join(root, "count.txt"), "42");
    expect(noData(join(root, "qemu.pid"))).toBe(true);
    expect(noData(join(root, "notes.pid"))).toBe(false);
    expect(noData(join(root, "count.txt"))).toBe(false);
  });

  it("an object file beside its source; one without is data", () => {
    writeFileSync(join(root, "lighting.c"), "int x;");
    writeFileSync(join(root, "lighting.o"), "\x7fELF");
    writeFileSync(join(root, "vendor.o"), "\x7fELF");
    expect(noData(join(root, "lighting.o"))).toBe(true);
    expect(noData(join(root, "vendor.o"))).toBe(false);
  });

  it("git's ORIG_HEAD when HEAD's reflog keeps its commit, and not otherwise", () => {
    const git = join(root, ".git");
    mkdirSync(join(git, "logs"), { recursive: true });
    writeFileSync(join(git, "ORIG_HEAD"), `${SHA}\n`);
    writeFileSync(join(git, "logs", "HEAD"), `0000000000000000000000000000000000000000 ${SHA} A <a@b> 1 +0000\tcommit: leak\n`);
    expect(noData(join(git, "ORIG_HEAD"))).toBe(true);
    writeFileSync(join(git, "logs", "HEAD"), "");
    expect(noData(join(git, "ORIG_HEAD"))).toBe(false);
    writeFileSync(join(root, "ORIG_HEAD"), `${SHA}\n`);
    expect(noData(join(root, "ORIG_HEAD"))).toBe(false);
  });

  it("a folder named like a system cache is not one", () => {
    mkdirSync(join(root, "var", "cache"), { recursive: true });
    writeFileSync(join(root, "var", "cache", "thesis.docx"), "mine");
    expect(noData(join(root, "var", "cache", "thesis.docx"))).toBe(false);
  });
});

describe("globHoldsNoData", () => {
  it("every object file the pattern matches has its source beside it; no match deletes nothing", () => {
    writeFileSync(join(root, "a.c"), "");
    writeFileSync(join(root, "a.o"), "");
    expect(globHoldsNoData(join(root, "*.o"))).toBe(true);
    expect(globHoldsNoData(join(root, "zz*.o"))).toBe(true);
    writeFileSync(join(root, "b.o"), "");
    expect(globHoldsNoData(join(root, "*.o"))).toBe(false);
    expect(globHoldsNoData(join(root, "*"))).toBe(false);
  });
});
