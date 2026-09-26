import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { ThreatEngine, getSessionCanaries, registerSessionCanaries, recoverSessionBreach } from "./threat-engine.js";
import { _setCanaryAuditTrail, adoptSessionCanaries } from "./canaries.js";
import { CryptoAuditTrail } from "./audit-trail.js";

let seq = 0;
function engineFor(sessionId: string): ThreatEngine {
  seq += 1;
  return new ThreatEngine(join(tmpdir(), `lax-canary-scope-${process.pid}-${seq}`), sessionId);
}

describe("canaries are minted once per process and shared by every session", () => {
  beforeEach(() => { _setCanaryAuditTrail(new CryptoAuditTrail(mkdtempSync(join(tmpdir(), "lax-canary-scope-audit-")))); });
  afterEach(() => { _setCanaryAuditTrail(null); });

  it("two chats embed the same canary block, so a new chat's system prompt matches the last one", () => {
    const a = engineFor("scope-chat-a");
    const b = engineFor("scope-chat-b");
    expect(a.getCanaryBlock()).toBe(b.getCanaryBlock());
    expect(getSessionCanaries("scope-chat-a")).toEqual(getSessionCanaries("scope-chat-b"));
    expect(getSessionCanaries("scope-chat-b").length).toBe(3);
  });

  it("each chat's egress registry holds exactly the tokens its prompt embeds", () => {
    const engine = engineFor("scope-chat-c");
    for (const token of getSessionCanaries("scope-chat-c")) expect(engine.getCanaryBlock()).toContain(token);
  });

  it("a breach recovery burns the shared set: the breached chat swaps now, another chat on its next turn", () => {
    const breached = engineFor("scope-breached");
    engineFor("scope-bystander");
    const old = getSessionCanaries("scope-breached");
    expect(breached.checkOutput(`leaked ${old[0]}`)).not.toBeNull();

    breached.approveRecovery("reviewed");
    const fresh = getSessionCanaries("scope-breached");
    for (const token of old) expect(fresh).not.toContain(token);
    expect(breached.getCanaryBlock()).toContain(fresh[0]);
    // A turn already in flight in the other chat still embeds the old tokens.
    expect(getSessionCanaries("scope-bystander")).toEqual(old);

    const nextTurn = engineFor("scope-bystander");
    expect(getSessionCanaries("scope-bystander")).toEqual(fresh);
    expect(nextTurn.getCanaryBlock()).toBe(breached.getCanaryBlock());
    expect(engineFor("scope-new-chat").getCanaryBlock()).toBe(breached.getCanaryBlock());
  });

  it("the /approve path rotates the same shared set", () => {
    const breached = engineFor("scope-approve");
    const old = getSessionCanaries("scope-approve");
    expect(breached.checkOutput(`leaked ${old[1]}`)).not.toBeNull();
    expect(recoverSessionBreach("scope-approve", "ok")).toBe(true);
    const fresh = getSessionCanaries("scope-approve");
    for (const token of old) expect(fresh).not.toContain(token);
    expect(engineFor("scope-after-approve").getCanaryBlock()).toContain(fresh[0]);
  });

  it("a breach in an op restored from an earlier process burns that op's own tokens too", () => {
    const earlier = ["CANARY-0123456789abcdef-ALPHA", "SENTINEL-0123456789abcdef-BRAVO", "TRIPWIRE-0123456789abcdef-CHARLIE"];
    const restored = engineFor("scope-restored");
    restored.restore({ ...restored.snapshot(), canaries: earlier });
    expect(restored.checkOutput(`leaked ${earlier[0]}`)).not.toBeNull();
    restored.approveRecovery("reviewed");
    // Lineage merged into another bucket drops the burned tokens when that bucket adopts.
    registerSessionCanaries("scope-bucket", [...earlier, "CANARY-fedcba9876543210-ALPHA"]);
    adoptSessionCanaries("scope-bucket");
    const bucket = getSessionCanaries("scope-bucket");
    for (const token of earlier) {
      expect(getSessionCanaries("scope-restored")).not.toContain(token);
      expect(bucket).not.toContain(token);
    }
    expect(bucket).toContain("CANARY-fedcba9876543210-ALPHA");
    expect(bucket).toEqual(expect.arrayContaining(getSessionCanaries("scope-restored")));
  });
});
