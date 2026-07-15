import { describe, it, expect, beforeEach } from "vitest";
import {
  registerSessionOwner,
  getSessionOwner,
  clearSessionOwner,
  resolveSessionBrowserProfileId,
  _resetSessionOwnerRegistry,
  DEFAULT_BROWSER_PROFILE_ID,
} from "./session-owner-registry.js";

beforeEach(() => _resetSessionOwnerRegistry());

describe("session→owner registry", () => {
  it("resolves an unregistered session to the default profile", () => {
    expect(resolveSessionBrowserProfileId("never-seen")).toBe(DEFAULT_BROWSER_PROFILE_ID);
    expect(getSessionOwner("never-seen")).toBeUndefined();
  });

  it("records and reads back an owner", () => {
    registerSessionOwner("agent-42", { agentId: "tpl-x", browserProfileId: "prof-nutrishop" });
    expect(getSessionOwner("agent-42")).toEqual({ agentId: "tpl-x", browserProfileId: "prof-nutrishop" });
    expect(resolveSessionBrowserProfileId("agent-42")).toBe("prof-nutrishop");
  });

  it("falls back to default when an owner has an agent but no profile", () => {
    registerSessionOwner("agent-7", { agentId: "tpl-y" });
    expect(resolveSessionBrowserProfileId("agent-7")).toBe(DEFAULT_BROWSER_PROFILE_ID);
  });

  it("merges partial updates without clobbering earlier fields", () => {
    registerSessionOwner("s1", { agentId: "tpl-z" });
    registerSessionOwner("s1", { browserProfileId: "prof-a" });
    expect(getSessionOwner("s1")).toEqual({ agentId: "tpl-z", browserProfileId: "prof-a" });
  });

  it("clears an owner so a reused session id can't inherit a stale profile", () => {
    registerSessionOwner("cron-1", { browserProfileId: "prof-b" });
    clearSessionOwner("cron-1");
    expect(getSessionOwner("cron-1")).toBeUndefined();
    expect(resolveSessionBrowserProfileId("cron-1")).toBe(DEFAULT_BROWSER_PROFILE_ID);
  });

  it("normalizes an empty session id to the default key", () => {
    registerSessionOwner("", { browserProfileId: "prof-c" });
    expect(resolveSessionBrowserProfileId("")).toBe("prof-c");
    expect(getSessionOwner(DEFAULT_BROWSER_PROFILE_ID)).toEqual({ agentId: undefined, browserProfileId: "prof-c" });
  });
});
