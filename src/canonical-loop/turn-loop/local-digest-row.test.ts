// On a local wire the situational digest is a history row, written on the
// rounds that carry one (local-digest-row.ts).
import { describe, expect, it, vi } from "vitest";
import type { Op } from "../../ops/types.js";
import { appendOpMessage, readOpMessages } from "../store.js";
import { LOCAL_DIGEST_EVERY, digestRowId, writeLocalDigestRow } from "./local-digest-row.js";

const digest = vi.hoisted(() => ({ text: "[SITUATIONAL CONTEXT] recent actions: remember" as string | null }));
vi.mock("./situational-awareness.js", () => ({ buildSituationalAwareness: async () => digest.text }));

let seq = 0;
const newOp = (provider: string, lane = "interactive") => ({
  id: `op_digest_row_${Date.now()}_${seq++}`, type: "chat_turn", task: "x", lane,
  contextPack: { routing: { preferredProvider: provider } },
} as unknown as Op);

const digestRows = (opId: string) => readOpMessages(opId).filter((r) => r.messageId.startsWith(`sa-${opId}-`));

function seed(opId: string) {
  appendOpMessage({ messageId: `um-${opId}-0-0`, opId, turnIdx: 0, seqInTurn: 0, role: "user", content: { text: "hi" }, createdAt: new Date().toISOString() });
}

describe("writeLocalDigestRow", () => {
  it("writes round 0's digest after the round's rows, as a harness row", async () => {
    const op = newOp("local");
    seed(op.id);
    await writeLocalDigestRow(op, 0);
    const rows = readOpMessages(op.id);
    expect(rows.map((r) => r.messageId)).toEqual([`um-${op.id}-0-0`, digestRowId(op.id, 0)]);
    expect(rows[1]).toMatchObject({ role: "user", turnIdx: 0, seqInTurn: 1, content: { text: digest.text, kind: "digest" } });
  });

  it("writes a retried round's row once, then one every LOCAL_DIGEST_EVERY rounds", async () => {
    const op = newOp("local");
    seed(op.id);
    for (let turn = 0; turn <= 2 * LOCAL_DIGEST_EVERY; turn++) {
      await writeLocalDigestRow(op, turn);
      await writeLocalDigestRow(op, turn);
    }
    expect(digestRows(op.id).map((r) => r.turnIdx)).toEqual([0, LOCAL_DIGEST_EVERY, 2 * LOCAL_DIGEST_EVERY]);
  });

  it("waits for the first round with something to say", async () => {
    const op = newOp("local");
    seed(op.id);
    digest.text = null;
    await writeLocalDigestRow(op, 0);
    digest.text = "[SITUATIONAL CONTEXT] recent actions: read";
    await writeLocalDigestRow(op, 1);
    expect(digestRows(op.id).map((r) => r.turnIdx)).toEqual([1]);
  });

  it("writes nothing for an op on a cloud provider, or on a lane without a digest", async () => {
    const cloud = newOp("anthropic");
    const build = newOp("local", "build");
    for (const op of [cloud, build]) {
      seed(op.id);
      await writeLocalDigestRow(op, 0);
      expect(digestRows(op.id)).toEqual([]);
    }
  });
});
