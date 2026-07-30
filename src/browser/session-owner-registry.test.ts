import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetSessionOwnerRegistry,
  aggregateBrowserSessionLineage,
  clearSessionOwner,
  DEFAULT_BROWSER_SESSION_ID,
  getSessionOwner,
  registerChildSessionOwner,
  registerSessionOwner,
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

  it("merges child taint and canaries into the chat browser bucket", () => {
    registerChildSessionOwner("agent-child", "chat-root");
    recordSensitiveRead("agent-child", "secret", "vault/item");
    registerSessionCanaries("agent-child", ["CANARY-child-ALPHA"]);
    expect(aggregateBrowserSessionLineage("agent-child")).toBe("chat-root");
    expect(checkEgressTaint("chat-root").blocked).toBe(true);
    expect(getSessionCanaries("chat-root")).toContain("CANARY-child-ALPHA");
  });
});
