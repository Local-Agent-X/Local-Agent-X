import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LAXConfig } from "../types/lax-config.js";

// Deleting a scheduled job wipes its own browser profile while the run the
// delete aborted may still be stopping: a browser call it already had in
// flight, a Chrome mid-launch, a close another caller started. None of them
// may write the profile dir back after the wipe. The fake Chrome below does
// what the real one does to its profile: creates it on launch and writes it
// again as it exits.

const state = vi.hoisted(() => ({ browserMode: "isolated", bridge: false }));
const chrome = vi.hoisted(() => ({
  launches: 0,
  closes: 0,
  launchLanding: null as Promise<void> | null,
  exitLanding: null as Promise<void> | null,
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  getRuntimeConfig: () => ({ browserMode: state.browserMode } as unknown as LAXConfig),
}));
vi.mock("../desktop-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktop-bridge.js")>()),
  desktopBridgeAvailable: () => state.bridge,
}));
vi.mock("./bridge-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bridge-client.js")>()),
  browserClearPartition: vi.fn(async () => undefined),
}));
vi.mock("./egress-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./egress-proxy.js")>()),
  startBrowserEgressProxy: vi.fn(async () => ({ url: "http://127.0.0.1:1", port: 1, close: async () => undefined })),
}));
vi.mock("./launcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launcher.js")>()),
  launchAgentChrome: vi.fn(async (_pw: unknown, _proxy: string, options: { userDataDir?: string }) => {
    const dir = options.userDataDir!;
    chrome.launches++;
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(join(dir, "Default", "Cookies"), "session=1");
    if (chrome.launchLanding) await chrome.launchLanding;
    const context = { pages: () => [] };
    return {
      browser: {
        contexts: () => [context],
        isConnected: () => true,
        close: async () => {
          if (chrome.exitLanding) await chrome.exitLanding;
          // Chrome flushes its state into the profile as it exits.
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "Local State"), "{}");
          chrome.closes++;
        },
      },
      chromeProcess: null,
      cleanup: async () => undefined,
    };
  }),
}));

import { closeAllBrowsers, getBrowserManager } from "./instance.js";
import { clearJobBrowserProfile } from "./job-browser-profile.js";
import {
  _resetSessionOwnerRegistry,
  JobBrowserProfileShutError,
  jobBrowserProfileDir,
  registerSessionOwner,
  setJobExistsCheck,
} from "./session-owner-registry.js";
import type { WindowsChatChromeRuntime } from "./windows-chat-chrome-runtime.js";

const JOB = "cron_j1";
const RUN = "cron-cron_j1-1700000000000";
const jobs = new Set<string>();
const dir = () => jobBrowserProfileDir(JOB);
const runtimeOf = (sessionId: string) =>
  (getBrowserManager(sessionId) as unknown as { runtime: WindowsChatChromeRuntime }).runtime;
const acquire = (runtime: WindowsChatChromeRuntime) => runtime.acquire("chromium", "isolated", RUN);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  _resetSessionOwnerRegistry();
  state.browserMode = "isolated";
  state.bridge = false;
  Object.assign(chrome, { launches: 0, closes: 0, launchLanding: null, exitLanding: null });
  jobs.clear();
  jobs.add(JOB);
  setJobExistsCheck((jobId) => jobs.has(jobId));
  registerSessionOwner(RUN, { browserProfile: { kind: "job", jobId: JOB } });
});
afterEach(async () => {
  await closeAllBrowsers();
  rmSync(dir(), { recursive: true, force: true });
});

describe("a run aborted by its job's delete cannot write the profile back", () => {
  it("a Chrome still launching when the job is deleted is waited out, then the dir is wiped", async () => {
    const landing = deferred();
    chrome.launchLanding = landing.promise;
    const runtime = runtimeOf(RUN);
    const launching = acquire(runtime);
    await vi.waitFor(() => expect(chrome.launches).toBe(1));
    jobs.delete(JOB);
    const wipe = clearJobBrowserProfile(JOB);
    setTimeout(landing.resolve, 20);
    await wipe;
    await launching;
    expect(chrome.closes).toBe(1);
    expect(existsSync(dir())).toBe(false);
  });

  it("a close another caller started (the run's own) is waited out too", async () => {
    const runtime = runtimeOf(RUN);
    await acquire(runtime);
    const exit = deferred();
    chrome.exitLanding = exit.promise;
    const runsOwnClose = runtime.stop();
    jobs.delete(JOB);
    const wipe = clearJobBrowserProfile(JOB);
    setTimeout(exit.resolve, 20);
    await wipe;
    await runsOwnClose;
    expect(chrome.closes).toBe(1);
    expect(existsSync(dir())).toBe(false);
  });

  it("after the wipe, the run's next browser call is refused and creates nothing", async () => {
    const stale = runtimeOf(RUN);
    await acquire(stale);
    jobs.delete(JOB);
    await clearJobBrowserProfile(JOB);
    // The aborted run's tool call still holding the old runtime:
    await expect(acquire(stale)).rejects.toBeInstanceOf(JobBrowserProfileShutError);
    // And a fresh one, CDP and in-app alike:
    await expect(acquire(runtimeOf(RUN))).rejects.toBeInstanceOf(JobBrowserProfileShutError);
    state.browserMode = "in-app";
    state.bridge = true;
    expect(() => getBrowserManager(RUN)).toThrow(JobBrowserProfileShutError);
    expect(chrome.launches).toBe(1);
    expect(existsSync(dir())).toBe(false);
  });

  it("a job that keeps running (Clear sign-ins) browses again after the wipe, on a fresh profile", async () => {
    await acquire(runtimeOf(RUN));
    await clearJobBrowserProfile(JOB);
    expect(chrome.closes).toBe(1);
    expect(existsSync(dir())).toBe(false);
    await acquire(runtimeOf(RUN));
    expect(chrome.launches).toBe(2);
  });
});
