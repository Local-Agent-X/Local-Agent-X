import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import {
  _resetSessionOwnerRegistry,
  aggregateBrowserSessionLineage,
  clearSessionOwner,
  DEFAULT_BROWSER_SESSION_ID,
  getSessionOwner,
  jobBrowserPartition,
  jobBrowserProfile,
  jobBrowserProfileDir,
  registerChildSessionOwner,
  registerSessionOwner,
  resolveBrowserProfile,
  resolveBrowserSessionId,
} from "./session-owner-registry.js";
import { checkEgressTaint, clearSessionTaint, recordSensitiveRead } from "../data-lineage/index.js";
import { clearSessionCanaries, getSessionCanaries, registerSessionCanaries } from "../threat/canaries.js";
import {
  CONTAINER_BROWSER_ACTING_SESSION,
  CONTAINER_BROWSER_OWNER_SESSION,
  CONTAINER_BROWSER_RELAY_FLAG,
} from "./container-bridge-transport.js";

beforeEach(() => {
  _resetSessionOwnerRegistry();
  for (const id of ["chat-root", "agent-parent", "agent-child"]) {
    clearSessionTaint(id);
    clearSessionCanaries(id);
  }
});

describe("session owner registry", () => {
  it("records, merges, normalizes, and clears owners", () => {
    registerSessionOwner("", { agentId: "tpl-x" });
    expect(getSessionOwner(DEFAULT_BROWSER_SESSION_ID)).toEqual({
      agentId: "tpl-x",
      browserSessionId: DEFAULT_BROWSER_SESSION_ID,
    });
    registerSessionOwner("", { browserSessionId: "chat-root" });
    expect(resolveBrowserSessionId("")).toBe("chat-root");
    clearSessionOwner("");
    expect(getSessionOwner(DEFAULT_BROWSER_SESSION_ID)).toBeUndefined();
  });

  it("flattens nested agents onto the root chat while unrelated roots stay isolated", () => {
    registerChildSessionOwner("agent-parent", "chat-root", { agentId: "parent" });
    registerChildSessionOwner("agent-child", "agent-parent", { agentId: "child" });
    expect(resolveBrowserSessionId("agent-parent")).toBe("chat-root");
    expect(resolveBrowserSessionId("agent-child")).toBe("chat-root");
    expect(resolveBrowserSessionId("cron-nightly")).toBe("cron-nightly");
  });

  it("uses the host-projected root inside a single-session container", () => {
    process.env[CONTAINER_BROWSER_RELAY_FLAG] = "1";
    process.env[CONTAINER_BROWSER_ACTING_SESSION] = "agent-child";
    process.env[CONTAINER_BROWSER_OWNER_SESSION] = "chat-root";
    try {
      expect(resolveBrowserSessionId("agent-child")).toBe("chat-root");
      expect(resolveBrowserSessionId("other-session")).toBe("other-session");
    } finally {
      delete process.env[CONTAINER_BROWSER_RELAY_FLAG];
      delete process.env[CONTAINER_BROWSER_ACTING_SESSION];
      delete process.env[CONTAINER_BROWSER_OWNER_SESSION];
    }
  });

  it("every session browses on the user's signed-in profile unless its run registered another", () => {
    expect(resolveBrowserProfile("chat-root")).toEqual({ kind: "signed-in" });
    registerSessionOwner("chat-root", { agentId: "tpl-x" });
    expect(resolveBrowserProfile("chat-root")).toEqual({ kind: "signed-in" });
    expect(getSessionOwner("chat-root")).toEqual({ agentId: "tpl-x", browserSessionId: "chat-root" });
  });

  it("a scheduled job's run browses on the job's own profile; the user's opt-in flips it to theirs", () => {
    registerSessionOwner("cron-j1-1", { browserProfile: jobBrowserProfile("cron_j1", undefined) });
    expect(resolveBrowserProfile("cron-j1-1")).toEqual({ kind: "job", jobId: "cron_j1" });
    registerSessionOwner("cron-j1-2", { browserProfile: jobBrowserProfile("cron_j1", true) });
    expect(resolveBrowserProfile("cron-j1-2")).toEqual({ kind: "signed-in" });
    // An agent the job spawns drives the job's browser, on the job's profile.
    registerChildSessionOwner("agent-of-job", "cron-j1-1", { agentId: "helper" });
    expect(resolveBrowserProfile("agent-of-job")).toEqual({ kind: "job", jobId: "cron_j1" });
    // A later registration without a profile keeps the one the run set.
    registerSessionOwner("cron-j1-1", { agentId: "tpl-y" });
    expect(resolveBrowserProfile("cron-j1-1")).toEqual({ kind: "job", jobId: "cron_j1" });
    clearSessionOwner("cron-j1-1");
    expect(resolveBrowserProfile("cron-j1-1")).toEqual({ kind: "signed-in" });
  });

  it("names a job's partition in the desktop's profile namespace and its Chrome profile dir under the data dir", () => {
    expect(jobBrowserPartition("cron_abc")).toBe("persist:lax-profile-job-cron_abc");
    expect(jobBrowserPartition("../x y")).toBe("persist:lax-profile-job----x-y");
    expect(jobBrowserProfileDir("cron_abc")).toBe(join(getLaxDir(), "browser-job-profiles", "cron_abc"));
    expect(jobBrowserProfileDir("../x")).toBe(join(getLaxDir(), "browser-job-profiles", "---x"));
  });

  it("merges child taint and canaries into the chat browser bucket", () => {
    registerChildSessionOwner("agent-child", "chat-root");
    recordSensitiveRead("agent-child", "secret", "vault/item");
    registerSessionCanaries("agent-child", ["CANARY-child-ALPHA"]);
    expect(aggregateBrowserSessionLineage("agent-child")).toBe("chat-root");
    expect(checkEgressTaint("chat-root").blocked).toBe(true);
    expect(getSessionCanaries("chat-root")).toContain("CANARY-child-ALPHA");
  });
});
