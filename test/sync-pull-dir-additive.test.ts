/**
 * Pins the `pullDir(src, dest, additiveOnly)` contract used by the
 * BRAIN_DIRS pull (agent-runs/, dashboards/).
 *
 * The bug it guards: locally-created run files were being deleted on
 * every pull because additiveOnly defaulted to false — pullDir's
 * "delete-local-entries-missing-from-remote" branch wiped any run that
 * lived only on this machine. Same data-loss family as the
 * agent-projects.json case.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullDir } from "../src/sync/mirror.js";

let remote: string;
let local: string;

beforeEach(() => {
  remote = mkdtempSync(join(tmpdir(), "pulldir-remote-"));
  local = mkdtempSync(join(tmpdir(), "pulldir-local-"));
});

afterEach(() => {
  try { rmSync(remote, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(local, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("pullDir — additiveOnly contract", () => {
  it("additive: keeps local files missing from remote (the bug we just fixed)", () => {
    writeFileSync(join(remote, "shared.json"), '{"shared": true}');
    writeFileSync(join(local, "shared.json"), '{"shared": true}');
    writeFileSync(join(local, "local-only.json"), '{"local": true}');

    pullDir(remote, local, /* additiveOnly */ true);

    expect(existsSync(join(local, "local-only.json"))).toBe(true);
    expect(existsSync(join(local, "shared.json"))).toBe(true);
  });

  it("destructive (legacy): wipes local files missing from remote", () => {
    writeFileSync(join(remote, "shared.json"), '{"shared": true}');
    writeFileSync(join(local, "shared.json"), '{"shared": true}');
    writeFileSync(join(local, "local-only.json"), '{"local": true}');

    pullDir(remote, local, /* additiveOnly */ false);

    expect(existsSync(join(local, "local-only.json"))).toBe(false);
    expect(existsSync(join(local, "shared.json"))).toBe(true);
  });

  it("additive: copies remote-only files into local", () => {
    writeFileSync(join(remote, "from-remote.json"), '{"from": "remote"}');

    pullDir(remote, local, /* additiveOnly */ true);

    expect(existsSync(join(local, "from-remote.json"))).toBe(true);
    expect(readFileSync(join(local, "from-remote.json"), "utf-8")).toBe('{"from": "remote"}');
  });

  it("additive: handles nested directories", () => {
    mkdirSync(join(remote, "sub"));
    writeFileSync(join(remote, "sub", "from-remote.json"), '{"nested": true}');
    mkdirSync(join(local, "sub"));
    writeFileSync(join(local, "sub", "local-only.json"), '{"local-nested": true}');

    pullDir(remote, local, /* additiveOnly */ true);

    expect(existsSync(join(local, "sub", "from-remote.json"))).toBe(true);
    expect(existsSync(join(local, "sub", "local-only.json"))).toBe(true);
  });

  it("additive: a freshly-created local file with no remote counterpart isn't wiped", () => {
    writeFileSync(join(local, "field-agent-1-justmade.json"), '{"status":"working"}');

    pullDir(remote, local, /* additiveOnly */ true);

    expect(existsSync(join(local, "field-agent-1-justmade.json"))).toBe(true);
  });
});
