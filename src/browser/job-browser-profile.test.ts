import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { BridgeUnavailableError } from "./bridge-client-contract.js";
import { jobBrowserPartition, jobBrowserProfileDir } from "./session-owner-registry.js";

// The order the wipe ran in, and what was on disk at each step.
const calls = vi.hoisted(() => ({ order: [] as string[], partitionError: null as Error | null }));

vi.mock("./instance.js", () => ({
  closeJobProfileBrowsers: vi.fn(async (jobId: string) => { calls.order.push(`close:${jobId}`); }),
}));
vi.mock("./bridge-client.js", () => ({
  browserClearPartition: vi.fn(async (partition: string) => {
    calls.order.push(`partition:${partition}`);
    if (calls.partitionError) throw calls.partitionError;
  }),
}));

import { clearJobBrowserProfile } from "./job-browser-profile.js";
import { closeJobProfileBrowsers } from "./instance.js";

const root = () => join(getLaxDir(), "browser-job-profiles");
const signedIn = () => join(getLaxDir(), "chrome-profile");

function seedProfile(dir: string): void {
  mkdirSync(join(dir, "Default"), { recursive: true });
  writeFileSync(join(dir, "Default", "Cookies"), "session=1");
}

beforeEach(() => {
  calls.order.length = 0;
  calls.partitionError = null;
  seedProfile(signedIn());
});
afterEach(() => {
  rmSync(root(), { recursive: true, force: true });
  rmSync(signedIn(), { recursive: true, force: true });
});

describe("clearJobBrowserProfile", () => {
  it("wipes the job's profile dir and its in-app partition, and nothing else", async () => {
    seedProfile(jobBrowserProfileDir("cron_a"));
    seedProfile(jobBrowserProfileDir("cron_b"));
    await clearJobBrowserProfile("cron_a");
    expect(existsSync(jobBrowserProfileDir("cron_a"))).toBe(false);
    expect(existsSync(join(jobBrowserProfileDir("cron_b"), "Default", "Cookies"))).toBe(true);
    expect(existsSync(join(signedIn(), "Default", "Cookies"))).toBe(true);
    expect(calls.order.filter((c) => c.startsWith("partition:"))).toEqual([`partition:${jobBrowserPartition("cron_a")}`]);
  });

  it("closes the live browsers on the profile before it wipes", async () => {
    const dir = jobBrowserProfileDir("cron_a");
    seedProfile(dir);
    vi.mocked(closeJobProfileBrowsers).mockImplementationOnce(async (jobId) => {
      calls.order.push(`close:${jobId}`);
      // Still there: nothing was wiped while a browser could hold it open.
      expect(existsSync(join(dir, "Default", "Cookies"))).toBe(true);
    });
    await clearJobBrowserProfile("cron_a");
    expect(calls.order).toEqual(["close:cron_a", `partition:${jobBrowserPartition("cron_a")}`]);
    expect(existsSync(dir)).toBe(false);
  });

  it("a job that never browsed clears cleanly", async () => {
    await expect(clearJobBrowserProfile("cron_never")).resolves.toBeUndefined();
  });

  it.each(["../chrome-profile", "..", "../../x", "a/../../chrome-profile", "..\\chrome-profile"])(
    "a hostile id (%s) stays inside browser-job-profiles",
    async (jobId) => {
      seedProfile(jobBrowserProfileDir("cron_b"));
      await clearJobBrowserProfile(jobId);
      expect(existsSync(join(signedIn(), "Default", "Cookies"))).toBe(true);
      expect(readdirSync(root())).toEqual(["cron_b"]);
      expect(existsSync(getLaxDir())).toBe(true);
    },
  );

  it("an id that names no dir of its own (the root itself) removes nothing", async () => {
    seedProfile(jobBrowserProfileDir("cron_b"));
    await expect(clearJobBrowserProfile("")).rejects.toThrow(/not one job's profile dir/);
    expect(existsSync(join(jobBrowserProfileDir("cron_b"), "Default", "Cookies"))).toBe(true);
    expect(calls.order).toEqual([]);
  });

  it("a link planted at the job's dir is removed, not followed into the signed-in profile", async () => {
    mkdirSync(root(), { recursive: true });
    symlinkSync(signedIn(), jobBrowserProfileDir("cron_a"), "junction");
    await clearJobBrowserProfile("cron_a");
    expect(existsSync(jobBrowserProfileDir("cron_a"))).toBe(false);
    expect(existsSync(join(signedIn(), "Default", "Cookies"))).toBe(true);
  });

  it("off the desktop there is no partition to clear; any other failure is the caller's", async () => {
    calls.partitionError = new BridgeUnavailableError("clear-partition");
    await expect(clearJobBrowserProfile("cron_a")).resolves.toBeUndefined();
    calls.partitionError = new Error("desktop refused the partition");
    await expect(clearJobBrowserProfile("cron_a")).rejects.toThrow("desktop refused the partition");
  });
});
