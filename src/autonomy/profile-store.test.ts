import { describe, it, expect, afterEach } from "vitest";
import {
  setSessionProfile,
  getSessionProfile,
  clearSessionProfile,
  inheritSessionProfile,
} from "./profile-store.js";

const touched: string[] = [];
function track(...ids: string[]): void { touched.push(...ids); }
afterEach(() => { for (const s of touched.splice(0)) clearSessionProfile(s); });

describe("session profile override store", () => {
  it("set / get / clear round-trips", () => {
    const s = "cron-job-1"; track(s);
    expect(getSessionProfile(s)).toBeUndefined();
    setSessionProfile(s, "Autonomous");
    expect(getSessionProfile(s)).toBe("Autonomous");
    clearSessionProfile(s);
    expect(getSessionProfile(s)).toBeUndefined();
  });

  it("inherits a parent's override onto a child session", () => {
    const parent = "cron-parent-1", child = "agent-child-1"; track(parent, child);
    setSessionProfile(parent, "Autonomous");

    const inherited = inheritSessionProfile(parent, child);

    expect(inherited).toBe("Autonomous");
    expect(getSessionProfile(child)).toBe("Autonomous");
  });

  it("inherits nothing when the parent has no override (child stays on global)", () => {
    const parent = "cron-parent-2", child = "agent-child-2"; track(parent, child);

    const inherited = inheritSessionProfile(parent, child);

    expect(inherited).toBeUndefined();
    expect(getSessionProfile(child)).toBeUndefined();
  });

  it("ignores an undefined parent (top-level spawn)", () => {
    const child = "agent-child-3"; track(child);
    expect(inheritSessionProfile(undefined, child)).toBeUndefined();
    expect(getSessionProfile(child)).toBeUndefined();
  });

  it("chains across hops: parent → child → grandchild", () => {
    const cron = "cron-x", child = "agent-x", grandchild = "agent-y";
    track(cron, child, grandchild);
    setSessionProfile(cron, "Autonomous");

    inheritSessionProfile(cron, child);      // first spawn
    inheritSessionProfile(child, grandchild); // child spawns its own sub-agent

    expect(getSessionProfile(grandchild)).toBe("Autonomous");
  });

  it("does not couple child lifetime to the parent: clearing the parent leaves the child", () => {
    const parent = "cron-parent-4", child = "agent-child-4"; track(parent, child);
    setSessionProfile(parent, "Autonomous");
    inheritSessionProfile(parent, child);

    clearSessionProfile(parent); // parent (cron) run finishes first

    expect(getSessionProfile(child)).toBe("Autonomous"); // child still pinned
  });
});
