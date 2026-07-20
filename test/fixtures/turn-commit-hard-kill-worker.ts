import { commitTurn } from "../../src/canonical-loop/checkpoint.js";
import { acquireLease } from "../../src/canonical-loop/lease.js";
import { _setTurnCommitWriteHookForTests } from "../../src/canonical-loop/turn-commit-store.js";
import { readOp } from "../../src/ops/op-store.js";
import { appendFileSync } from "node:fs";
import { canonicalEventsPath } from "../../src/canonical-loop/schema.js";

const opId = process.argv[2];
const mode = process.argv[3] ?? "published";
const op = readOp(opId);
if (!op) throw new Error(`missing op ${opId}`);
if (mode === "partial-event") {
  appendFileSync(canonicalEventsPath(opId), "{\"opId\":");
  if (process.send) process.send({ published: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const acquired = acquireLease(opId, `hard-kill-${process.pid}`);
if (!acquired.ok) throw new Error(`lease failed: ${acquired.reason}`);

_setTurnCommitWriteHookForTests((point) => {
  const boundary = mode === "stage" ? "after_stage_fsync" : "after_publish";
  if (point !== boundary) return;
  if (process.send) process.send({ published: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});

commitTurn({
  op: readOp(opId)!, leaseClaim: acquired.claim, turnIdx: 0,
  providerState: { adapterName: "kill-fixture", adapterVersion: "1", providerPayload: null },
  messages: [{ messageId: `${opId}-reply`, role: "assistant", content: "published reply" }],
  toolCallSummary: [{ tool: "write", argsHash: "h", resultStatus: "ok", durationMs: 1 }],
  terminalReason: "done",
});
