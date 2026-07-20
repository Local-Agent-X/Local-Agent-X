import { afterAll, afterEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commitTurn, type CommitTurnInput } from "../src/canonical-loop/checkpoint.js";
import { acquireLease, type LeaseClaim } from "../src/canonical-loop/lease.js";
import { canonicalEventsPath, opMessagesPath, opTurnPath, opTurnsDir } from "../src/canonical-loop/schema.js";
import {
  appendCanonicalEvent,
  appendCanonicalEventStrict,
  appendOpMessage,
  readCanonicalEvents,
  readOpMessages,
  readOpTurn,
} from "../src/canonical-loop/store.js";
import {
  _setTurnCommitWriteHookForTests,
  readLegacyMessageSeeds,
  scavengeTurnCommitStages,
  type TurnCommitEnvelope,
} from "../src/canonical-loop/turn-commit-store.js";
import { actionLogDir, appendActionLedgerOnce, readSessionActions } from "../src/ops/action-ledger.js";
import { newOpId, readOp, writeOp } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import type { OpMessageRow } from "../src/canonical-loop/types.js";

const OPS = join(homedir(), ".lax", "operations");
const ids: string[] = [];
const sessions: string[] = [];

function mkOp(label: string): { op: Op; claim: LeaseClaim } {
  const op: Op = {
    id: newOpId(`durability_${label}`), type: "freeform", task: label,
    contextPack: {} as Op["contextPack"], lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 2, backoffMs: [1] }, ownerId: "test",
    visibility: "private", status: "running", createdAt: new Date().toISOString(),
    attemptCount: 0, canonical: { flagValue: true, state: "running", sessionId: `durability-${label}` },
  };
  ids.push(op.id); sessions.push(op.canonical!.sessionId!); writeOp(op);
  mkdirSync(opTurnsDir(op.id), { recursive: true });
  const lease = acquireLease(op.id, `worker-${label}`);
  if (!lease.ok) throw new Error(lease.reason);
  return { op: readOp(op.id)!, claim: lease.claim };
}

function input(op: Op, claim: LeaseClaim, messageId = `${op.id}-reply`, turnIdx = 0): CommitTurnInput {
  return {
    op, leaseClaim: claim, turnIdx,
    providerState: { adapterName: "fake", adapterVersion: "1", providerPayload: null },
    messages: [{ messageId, role: "assistant", content: "reply" }],
    toolCallSummary: [{ tool: "read", argsHash: "h", resultStatus: "ok", durationMs: 1 }],
    terminalReason: null,
  };
}

function envelope(op: Op): TurnCommitEnvelope {
  return {
    schemaVersion: 1,
    turn: {
      opId: op.id, turnIdx: 0,
      providerState: { adapterName: "fake", adapterVersion: "1", providerPayload: null },
      toolCallSummary: [], terminalReason: null, redirectConsumed: false,
      createdAt: new Date().toISOString(),
    },
    messages: [{
      messageId: `${op.id}-reply`, opId: op.id, turnIdx: 0, seqInTurn: 0,
      role: "assistant", content: "reply", createdAt: new Date().toISOString(),
    }],
    projection: {
      opType: op.type,
      sessionId: op.canonical!.sessionId!,
      task: op.task,
      stateBefore: "running",
    },
  };
}

afterEach(() => _setTurnCommitWriteHookForTests(null));
afterAll(() => {
  for (const id of ids) rmSync(join(OPS, id), { recursive: true, force: true });
  for (const session of sessions) rmSync(join(actionLogDir(), `${session}.jsonl`), { force: true });
});

describe("strict turn envelope validation", () => {
  const corruptions: Array<[string, (value: any) => void]> = [
    ["schema", (v) => { v.schemaVersion = 2; }],
    ["turn-provider", (v) => { delete v.turn.providerState.providerPayload; }],
    ["turn-tools", (v) => { v.turn.toolCallSummary = [{ tool: "x", argsHash: "h", resultStatus: "ok", durationMs: "1" }]; }],
    ["turn-terminal", (v) => { v.turn.terminalReason = "maybe"; }],
    ["message-role", (v) => { v.messages[0].role = "developer"; }],
    ["message-content", (v) => { delete v.messages[0].content; }],
    ["message-duplicate", (v) => { v.messages.push({ ...v.messages[0] }); }],
    ["projection", (v) => { delete v.projection.opType; }],
    ["projection-state", (v) => { v.projection.stateBefore = "unknown"; }],
  ];

  for (const [name, corrupt] of corruptions) {
    it(`quarantines and re-drives malformed ${name}`, () => {
      const { op, claim } = mkOp(`invalid-${name}`);
      const value: any = envelope(op);
      corrupt(value);
      writeFileSync(opTurnPath(op.id, 0), JSON.stringify(value));
      expect(commitTurn(input(op, claim)).inserted).toBe(true);
      expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
      expect(readdirSync(opTurnsDir(op.id)).some((file) => file.endsWith(".corrupt"))).toBe(true);
    });
  }

  it("rejects a legacy-shaped final missing mandatory fields", () => {
    const { op, claim } = mkOp("invalid-legacy");
    writeFileSync(opTurnPath(op.id, 0), JSON.stringify({ opId: op.id, turnIdx: 0 }));
    expect(commitTurn(input(op, claim)).inserted).toBe(true);
    expect(readdirSync(opTurnsDir(op.id)).some((file) => file.endsWith(".corrupt"))).toBe(true);
  });

  for (const [name, value] of [
    ["null", null], ["array", []], ["string", "turn"], ["number", 7],
    ["empty", {}], ["shallow-envelope", { schemaVersion: 1, turn: {}, messages: [], projection: {} }],
  ] as const) {
    it(`quarantines fuzzed ${name} final data`, () => {
      const { op, claim } = mkOp(`fuzz-${name}`);
      writeFileSync(opTurnPath(op.id, 0), JSON.stringify(value));
      expect(commitTurn(input(op, claim)).inserted).toBe(true);
      expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
    });
  }
});

describe("message collision safety", () => {
  function seed(opId: string): OpMessageRow {
    return {
      messageId: `${opId}-seed`, opId, turnIdx: 0, seqInTurn: 0, role: "user",
      content: "canonical request", createdAt: new Date().toISOString(),
    };
  }

  it("rejects a finalized messageId collision without replacing the seed", () => {
    const { op, claim } = mkOp("id-collision");
    const row = seed(op.id); appendOpMessage(row);
    expect(() => commitTurn(input(op, claim, row.messageId))).toThrow("message collision");
    expect(readOpTurn(op.id, 0)).toBeNull();
    expect(readOpMessages(op.id)).toEqual([row]);
  });

  it("quarantines a finalized composite-position collision and preserves the seed", () => {
    const { op, claim } = mkOp("position-collision");
    const row = seed(op.id); appendOpMessage(row);
    const value = envelope(op);
    value.messages[0].messageId = `${op.id}-different`;
    writeFileSync(opTurnPath(op.id, 0), JSON.stringify(value));
    expect(commitTurn(input(op, claim)).inserted).toBe(true);
    const messages = readOpMessages(op.id);
    expect(messages[0]).toEqual(row);
    expect(messages[1].seqInTurn).toBe(1);
  });

  it("quarantines a duplicate messageId from a later envelope and re-drives it", () => {
    const { op, claim } = mkOp("cross-envelope-id");
    commitTurn(input(op, claim, "shared-message", 0));
    const later = envelope(op);
    later.turn.turnIdx = 1;
    later.messages[0] = { ...later.messages[0], turnIdx: 1, messageId: "shared-message" };
    writeFileSync(opTurnPath(op.id, 1), JSON.stringify(later));
    expect(commitTurn(input(readOp(op.id)!, claim, "unique-message", 1)).inserted).toBe(true);
    expect(readOpMessages(op.id).map((row) => row.messageId)).toEqual(["shared-message", "unique-message"]);
    expect(readdirSync(opTurnsDir(op.id)).some((file) => file.startsWith("1.json.") && file.endsWith(".corrupt"))).toBe(true);
  });

  function writeSeeds(opId: string, rows: OpMessageRow[], tail = ""): string {
    const raw = rows.map((row) => JSON.stringify(row)).join("\n") + `\n${tail}`;
    writeFileSync(opMessagesPath(opId), raw);
    return raw;
  }

  it("fails closed on duplicate raw seed IDs at different positions without dropping evidence", () => {
    const { op, claim } = mkOp("raw-duplicate-id");
    const first = seed(op.id);
    const second = { ...first, seqInTurn: 1 };
    const raw = writeSeeds(op.id, [first, second]);
    expect(readLegacyMessageSeeds(op.id).issues.map((issue) => issue.kind))
      .toContain("duplicate_message_id");
    expect(() => readOpMessages(op.id)).toThrow("legacy message seed integrity");
    expect(() => commitTurn(input(op, claim))).toThrow("legacy message seed integrity");
    expect(readFileSync(opMessagesPath(op.id), "utf-8")).toBe(raw);
    expect(readOpTurn(op.id, 0)).toBeNull();
    expect(readSessionActions(op.canonical!.sessionId!)).toEqual([]);
    expect(readOp(op.id)?.canonical?.state).toBe("running");
  });

  it("fails closed on duplicate raw seed positions with different IDs", () => {
    const { op, claim } = mkOp("raw-duplicate-position");
    const first = seed(op.id);
    const second = { ...first, messageId: `${op.id}-other` };
    writeSeeds(op.id, [first, second]);
    expect(readLegacyMessageSeeds(op.id).issues.map((issue) => issue.kind))
      .toContain("duplicate_position");
    expect(() => commitTurn(input(op, claim))).toThrow("legacy message seed integrity");
    expect(readOpTurn(op.id, 0)).toBeNull();
  });

  it("reports both a malformed raw tail and an earlier seed collision", () => {
    const { op, claim } = mkOp("raw-tail-collision");
    const first = seed(op.id);
    const raw = writeSeeds(op.id, [first, { ...first, seqInTurn: 1 }], "{\"messageId\":");
    expect(readLegacyMessageSeeds(op.id).issues.map((issue) => issue.kind))
      .toEqual(["duplicate_message_id", "malformed_row"]);
    expect(() => commitTurn(input(op, claim))).toThrow("legacy message seed integrity");
    expect(readFileSync(opMessagesPath(op.id), "utf-8")).toBe(raw);
    expect(readOpTurn(op.id, 0)).toBeNull();
  });

  it("revalidates a concurrent raw seed append immediately before rename", () => {
    const { op, claim } = mkOp("raw-before-rename");
    const first = seed(op.id);
    appendOpMessage(first);
    const eventsBefore = readCanonicalEvents(op.id);
    _setTurnCommitWriteHookForTests((point) => {
      if (point !== "before_publish") return;
      appendFileSync(opMessagesPath(op.id), JSON.stringify({
        ...first, seqInTurn: 2, createdAt: new Date().toISOString(),
      }) + "\n");
    });
    expect(() => commitTurn(input(op, claim))).toThrow("legacy message seed integrity");
    expect(readOpTurn(op.id, 0)).toBeNull();
    expect(readCanonicalEvents(op.id)).toEqual(eventsBefore);
    expect(readSessionActions(op.canonical!.sessionId!)).toEqual([]);
    expect(readOp(op.id)?.canonical?.state).toBe("running");
  });

  it("keeps valid legacy seed behavior and appends after its position", () => {
    const { op, claim } = mkOp("raw-valid-parity");
    const first = seed(op.id);
    appendOpMessage(first);
    expect(commitTurn(input(op, claim, `${op.id}-answer`)).inserted).toBe(true);
    expect(readOpMessages(op.id)).toEqual([
      first,
      expect.objectContaining({ messageId: `${op.id}-answer`, turnIdx: 0, seqInTurn: 1 }),
    ]);
  });

  it("never quarantines an already-published turn after a malformed legacy tail appears", () => {
    const { op, claim } = mkOp("published-before-malformed-tail");
    expect(commitTurn(input(op, claim)).inserted).toBe(true);
    const target = opTurnPath(op.id, 0);
    const published = readFileSync(target, "utf-8");
    writeFileSync(opMessagesPath(op.id), '{"messageId":\n');

    expect(() => commitTurn(input(readOp(op.id)!, claim))).toThrow("legacy message seed integrity");
    expect(readFileSync(target, "utf-8")).toBe(published);
    expect(readdirSync(opTurnsDir(op.id)).filter((name) => name.endsWith(".corrupt"))).toEqual([]);
    expect(readOpTurn(op.id, 0)).toBeNull();

    writeFileSync(opMessagesPath(op.id), "");
    expect(commitTurn(input(readOp(op.id)!, claim)).inserted).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe(published);
    expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
  });

  it("never quarantines an already-published turn after duplicate legacy rows appear", () => {
    const { op, claim } = mkOp("published-before-duplicate-rows");
    expect(commitTurn(input(op, claim)).inserted).toBe(true);
    const target = opTurnPath(op.id, 0);
    const published = readFileSync(target, "utf-8");
    const first = { ...seed(op.id), turnIdx: 1 };
    writeSeeds(op.id, [first, { ...first, seqInTurn: 1 }]);

    expect(() => commitTurn(input(readOp(op.id)!, claim))).toThrow("legacy message seed integrity");
    expect(readFileSync(target, "utf-8")).toBe(published);
    expect(readdirSync(opTurnsDir(op.id)).filter((name) => name.endsWith(".corrupt"))).toEqual([]);
  });

  it("never quarantines an already-published turn after a foreign legacy row appears", () => {
    const { op, claim } = mkOp("published-before-foreign-row");
    expect(commitTurn(input(op, claim)).inserted).toBe(true);
    const target = opTurnPath(op.id, 0);
    const published = readFileSync(target, "utf-8");
    writeSeeds(op.id, [{ ...seed(op.id), opId: "foreign-op", turnIdx: 1 }]);

    expect(() => commitTurn(input(readOp(op.id)!, claim))).toThrow("legacy message seed integrity");
    expect(readFileSync(target, "utf-8")).toBe(published);
    expect(readdirSync(opTurnsDir(op.id)).filter((name) => name.endsWith(".corrupt"))).toEqual([]);
  });
});

describe("projection identity", () => {
  for (const field of ["opType", "sessionId", "task"] as const) {
    it(`quarantines a forged ${field} and projects only to the authoritative op`, () => {
      const { op, claim } = mkOp(`forged-${field}`);
      const forged = envelope(op);
      forged.projection[field] = `foreign-${field}`;
      writeFileSync(opTurnPath(op.id, 0), JSON.stringify(forged));
      expect(commitTurn(input(op, claim)).inserted).toBe(true);
      expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
      expect(readSessionActions(`foreign-${field}`)).toEqual([]);
      expect(readdirSync(opTurnsDir(op.id)).some((file) => file.endsWith(".corrupt"))).toBe(true);
    });
  }

  it("uses the legacy empty-session identity when sessionId is absent", () => {
    const { op } = mkOp("identity-sessionless");
    const current = readOp(op.id)!;
    delete current.canonical!.sessionId;
    writeOp(current);
    const value = envelope(current);
    value.projection.sessionId = "";
    writeFileSync(opTurnPath(op.id, 0), JSON.stringify(value));
    expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
  });

  it("rejects envelopes when current canonical identity is malformed", () => {
    const { op } = mkOp("identity-malformed");
    const value = envelope(op);
    writeFileSync(opTurnPath(op.id, 0), JSON.stringify(value));
    const current = readOp(op.id)!;
    (current.canonical as { sessionId?: unknown }).sessionId = 42;
    writeOp(current);
    expect(readOpTurn(op.id, 0)).toBeNull();
  });

  it("preserves a complete legacy row using opId truth without projection identity", () => {
    const { op } = mkOp("identity-legacy-row");
    const row = envelope(op).turn;
    const current = readOp(op.id)!;
    delete current.canonical;
    writeOp(current);
    writeFileSync(opTurnPath(op.id, 0), JSON.stringify(row));
    expect(readOpTurn(op.id, 0)).toEqual(row);
  });
});

describe("durable projections and publication", () => {
  it("repairs only a partial event tail and preserves a complete semantic sequence error", () => {
    const { op } = mkOp("event-tail");
    appendCanonicalEvent(op.id, "turn_started", { turnIdx: 0 });
    appendFileSync(canonicalEventsPath(op.id), "{\"opId\":");
    appendCanonicalEvent(op.id, "message_appended", { messageId: "m" });
    expect(readCanonicalEvents(op.id).map((event) => event.seq)).toEqual([0, 1]);
    appendFileSync(canonicalEventsPath(op.id), JSON.stringify({
      opId: op.id, seq: 99, type: "error", ts: new Date().toISOString(), body: null,
    }) + "\n");
    const before = readFileSync(canonicalEventsPath(op.id), "utf-8");
    expect(readCanonicalEvents(op.id).map((event) => event.seq)).toEqual([0, 1, 99]);
    expect(() => appendCanonicalEventStrict(op.id, "turn_committed", { turnIdx: 0 }))
      .toThrow("seq gap detected");
    expect(readFileSync(canonicalEventsPath(op.id), "utf-8")).toBe(before);
  });

  it("repairs an action tail and keeps once-only projection idempotent", () => {
    const { op } = mkOp("action-tail");
    const entry = {
      ts: new Date().toISOString(), sessionId: op.canonical!.sessionId!, opId: op.id,
      opType: op.type, turnIdx: 0, task: op.task,
      actions: [{ tool: "read", status: "ok" as const }], terminalReason: null,
    };
    appendActionLedgerOnce(entry);
    appendFileSync(join(actionLogDir(), `${entry.sessionId}.jsonl`), "{\"ts\":");
    appendActionLedgerOnce(entry);
    expect(readSessionActions(entry.sessionId)).toEqual([entry]);
  });

  it("publishes only after the parent directory fsync boundary", () => {
    const { op, claim } = mkOp("directory-fsync");
    _setTurnCommitWriteHookForTests((point) => {
      if (point === "after_directory_fsync") throw new Error("crash:directory-fsync");
    });
    expect(() => commitTurn(input(op, claim))).toThrow("crash:directory-fsync");
    expect(readOpTurn(op.id, 0)?.turnIdx).toBe(0);
  });

  it("scavenges dead stages but never a stage owned by a live process", () => {
    const { op, claim } = mkOp("stage-owner");
    const live = join(opTurnsDir(op.id), `0.json.${process.pid}-00000000-0000-0000-0000-000000000000.stage`);
    const dead = join(opTurnsDir(op.id), "0.json.99999999-00000000-0000-0000-0000-000000000000.stage");
    writeFileSync(live, "live"); writeFileSync(dead, "dead");
    expect(scavengeTurnCommitStages(op.id)).toBe(1);
    expect(existsSync(live)).toBe(true);
    commitTurn(input(op, claim));
    expect(existsSync(live)).toBe(true);
    rmSync(live, { force: true });
  });
});
