// A container forwards its session's taint as full-state deltas, and the host
// replaced the session's entries with them wholesale — so the entries the
// host wrote under that key (the parent's taint inherited at bind, a
// recovery replay) vanished on the container's first forward (red team
// round 2, T-M3). Forwarded entries now replace only forwarded entries.
import { afterEach, describe, expect, it } from "vitest";
import { checkEgressTaint, clearSessionTaint, getTaintSummary, recordSensitiveRead, setForwardedSessionTaint } from "./taint.js";
import type { TaintEntry } from "./fingerprint.js";

const SID = "op_forward_merge";
const entry = (target: string): TaintEntry => ({ source: "sensitive_file", target, timestamp: 1, runId: SID, fingerprints: ["a1"], complete: true });
/** The targets the session's egress block names, in order. */
const held = (): string[] => (checkEgressTaint(SID).reason ?? "").match(/sensitive_file:([^,)]+)/g)?.map((m) => m.slice("sensitive_file:".length)) ?? [];

afterEach(() => clearSessionTaint(SID));

describe("a container's forwarded taint", () => {
  it("joins the host's own entries instead of replacing them", () => {
    recordSensitiveRead(SID, "sensitive_file", "/home/u/.env", "SECRET=inherited-from-the-parent-session-1234");
    setForwardedSessionTaint(SID, [entry("/work/a.key"), entry("/work/b.key")]);
    expect(getTaintSummary(SID).count).toBe(3);
    // A later full-state delta replaces the container's entries only.
    setForwardedSessionTaint(SID, [entry("/work/c.key")]);
    expect(getTaintSummary(SID).count).toBe(2);
    expect(held().sort()).toEqual(["/home/u/.env", "/work/c.key"]);
  });

  it("an empty delta — the container retracted everything — keeps the host's entries", () => {
    recordSensitiveRead(SID, "sensitive_file", "/home/u/.env", "SECRET=inherited-from-the-parent-session-1234");
    setForwardedSessionTaint(SID, [entry("/work/a.key")]);
    setForwardedSessionTaint(SID, []);
    expect(held()).toEqual(["/home/u/.env"]);
  });

  it("clears the session when nothing of the host's was there", () => {
    setForwardedSessionTaint(SID, [entry("/work/a.key")]);
    setForwardedSessionTaint(SID, []);
    expect(getTaintSummary(SID).count).toBe(0);
  });
});
