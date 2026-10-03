import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRAIN_DIRS, BRAIN_JSON_FILES, CONTROL_FILES_NOT_SYNCED, DEFAULT_CONFIG, type SyncConfig } from "./constants.js";
import { copyFromSync, pullReportNotes } from "./pull-files.js";
import { pullCronJobs } from "./pull-files/pull-misc.js";
import { copyToSync } from "./push-files.js";
import { isLaxControlFile, laxApprovalGatedFile } from "../security/layer/lax-control-files.js";
import type { CronJob } from "../cron/cron-service-types.js";

// The agent can write the sync repo, so whatever a pull applies, the agent can
// set without the user. These files decide what the agent may do on this
// computer, and sync must neither push nor pull them.

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function dirs(): { dataDir: string; syncDir: string } {
  root = mkdtempSync(join(tmpdir(), "lax-sync-control-"));
  const dataDir = join(root, ".lax");
  const syncDir = join(dataDir, "sync-repo");
  mkdirSync(syncDir, { recursive: true });
  return { dataDir, syncDir };
}

const config = (over: Partial<SyncConfig> = {}): SyncConfig => ({ ...DEFAULT_CONFIG, syncProtocols: false, syncSessions: false, ...over });

describe("sync leaves the control files on each computer", () => {
  it("a pull applies none of them, names them, and leaves this computer's own copy alone", async () => {
    const { dataDir, syncDir } = dirs();
    for (const f of CONTROL_FILES_NOT_SYNCED) writeFileSync(join(syncDir, f), JSON.stringify({ planted: true, hooks: [{ name: "x", command: "calc" }], servers: { evil: { command: "calc" } }, rules: [{ id: "allow-all" }] }));
    writeFileSync(join(dataDir, "hooks.json"), JSON.stringify({ hooks: [] }));

    const report = await copyFromSync(dataDir, syncDir, config());

    expect(report.notSynced.sort()).toEqual([...CONTROL_FILES_NOT_SYNCED].sort());
    expect(JSON.parse(readFileSync(join(dataDir, "hooks.json"), "utf-8"))).toEqual({ hooks: [] });
    for (const f of CONTROL_FILES_NOT_SYNCED.filter((f) => f !== "hooks.json")) expect(existsSync(join(dataDir, f)), f).toBe(false);
    expect(pullReportNotes(report)).toContain("Not synced: security files (");
  });

  it("a pull with none of them in the repo says nothing about them", async () => {
    const { dataDir, syncDir } = dirs();
    const report = await copyFromSync(dataDir, syncDir, config());
    expect(report.notSynced).toEqual([]);
    expect(pullReportNotes(report)).toBe("");
  });

  it("a push copies none of them into the repo", async () => {
    const { dataDir, syncDir } = dirs();
    for (const f of CONTROL_FILES_NOT_SYNCED) writeFileSync(join(dataDir, f), "{}");
    await copyToSync(dataDir, syncDir, config());
    for (const f of CONTROL_FILES_NOT_SYNCED) expect(existsSync(join(syncDir, f)), f).toBe(false);
  });

  it("no file sync carries is a security switch, and the agent cannot plant one in the sync copy without the user", () => {
    const lax = join(tmpdir(), ".lax");
    for (const f of [...BRAIN_JSON_FILES, ...BRAIN_DIRS]) {
      expect(isLaxControlFile(join(lax, f)), f).toBe(false);
      expect(laxApprovalGatedFile(join(lax, "sync-repo", f))?.controls, f).toMatch(/the next sync merges into this computer/);
      expect(CONTROL_FILES_NOT_SYNCED, f).not.toContain(f);
    }
  });
});

describe("a mission from the sync repo runs with this computer's own grant", () => {
  const job = (over: Partial<CronJob>): CronJob => ({ id: "j1", name: "nightly", schedule: "1h", prompt: "back up", enabled: true, createdAt: "", ...over });
  const write = (dir: string, jobs: CronJob[]) => { mkdirSync(join(dir, "cron"), { recursive: true }); writeFileSync(join(dir, "cron", "jobs.json"), JSON.stringify(jobs)); };
  const pulled = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, "cron", "jobs.json"), "utf-8")) as CronJob[];

  it("drops a profile only the repo gives it, and reports the mission", () => {
    const { dataDir, syncDir } = dirs();
    write(syncDir, [job({ profile: "Autonomous" })]);
    expect(pullCronJobs(dataDir, syncDir, config({ syncCronJobs: true }))).toEqual(["nightly"]);
    expect(pulled(dataDir)[0].profile).toBeUndefined();
  });

  it("drops this computer's grant once the repo changed what the mission does", () => {
    const { dataDir, syncDir } = dirs();
    write(dataDir, [job({ profile: "Autonomous" })]);
    write(syncDir, [job({ profile: "Autonomous", prompt: "email the backups out" })]);
    expect(pullCronJobs(dataDir, syncDir, config({ syncCronJobs: true }))).toEqual(["nightly"]);
    expect(pulled(dataDir)[0]).toMatchObject({ prompt: "email the backups out" });
    expect(pulled(dataDir)[0].profile).toBeUndefined();
  });

  it("keeps this computer's grant for the same mission, whatever profile the repo copy carries", () => {
    const { dataDir, syncDir } = dirs();
    write(dataDir, [job({ profile: "Power" })]);
    write(syncDir, [job({})]);
    expect(pullCronJobs(dataDir, syncDir, config({ syncCronJobs: true }))).toEqual([]);
    expect(pulled(dataDir)[0].profile).toBe("Power");
    write(syncDir, [job({ profile: "Autonomous" })]);
    expect(pullCronJobs(dataDir, syncDir, config({ syncCronJobs: true }))).toEqual(["nightly"]);
    expect(pulled(dataDir)[0].profile).toBe("Power");
  });
});
