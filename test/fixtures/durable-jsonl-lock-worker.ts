import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _setDurableJsonlLockHookForTests,
  updateDurableJsonl,
} from "../../src/persistence/durable-jsonl.js";

const [path, id, gate] = process.argv.slice(2);
const sleep = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (target: string): void => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(target)) {
    if (Date.now() > deadline) throw new Error(`gate timeout: ${target}`);
    Atomics.wait(sleep, 0, 0, 5);
  }
};

writeFileSync(join(gate, `ready-${id}`), "ready");
waitFor(join(gate, "go"));
_setDurableJsonlLockHookForTests((point) => {
  if (point === "after_reclaim_observe") {
    writeFileSync(join(gate, `observed-${id}`), "observed");
    waitFor(join(gate, "observed-a"));
    waitFor(join(gate, "observed-b"));
  }
  if (point === "after_acquire") {
    writeFileSync(join(gate, `acquired-${id}`), "acquired");
    waitFor(join(gate, "release"));
  }
});

updateDurableJsonl(path, (value): value is { id: string } =>
  !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string",
() => ({ id }));
