// The data folder LAX_DATA_DIR configures may be named anything (a container
// deployment's CONTAINER_DATA, a test's temp dir). Its control files are the
// same switches as in a `.lax` folder, so they get the same hard block, card
// and at-rest-secret refusal; before GHSA-9mv6 only a folder named `.lax` did.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppAtRestSecretUnderLax, isLaxControlFile, laxApprovalGatedFile } from "./lax-control-files.js";

const prev = process.env.LAX_DATA_DIR;
let dir = "";
let elsewhere = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "CONTAINER_DATA-"));
  elsewhere = mkdtempSync(join(tmpdir(), "user-project-"));
  process.env.LAX_DATA_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

describe("a data folder not named .lax", () => {
  it("has its security switches hard-blocked", () => {
    expect(isLaxControlFile(join(dir, "settings.json"))).toBe(true);
    expect(isLaxControlFile(join(dir, "autonomy-profile.json"))).toBe(true);
  });

  it("has its card-gated files put to the user", () => {
    expect(laxApprovalGatedFile(join(dir, "hooks.json"))?.controls).toMatch(/runs commands on every tool call/);
  });

  it("has its at-rest secrets refused", () => {
    expect(isAppAtRestSecretUnderLax(join(dir, "audit-key"))).toBe(true);
  });

  // A test or container layout may put the workspace in the same folder, so
  // a file the catalog does not name is the workspace's there (in a `.lax`
  // folder it is put to the user).
  it("leaves a file the catalog does not name alone", () => {
    expect(laxApprovalGatedFile(join(dir, "durable.txt"))).toBeNull();
    expect(isLaxControlFile(join(dir, "durable.txt"))).toBe(false);
  });

  it("leaves the same names in the user's own folders alone", () => {
    expect(isLaxControlFile(join(elsewhere, "settings.json"))).toBe(false);
    expect(laxApprovalGatedFile(join(elsewhere, "hooks.json"))).toBeNull();
    expect(isAppAtRestSecretUnderLax(join(elsewhere, "audit-key"))).toBe(false);
  });
});
