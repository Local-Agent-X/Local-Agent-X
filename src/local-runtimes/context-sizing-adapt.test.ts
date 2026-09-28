import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetContextSizingForTests, appliedContext, contextSizingRecord, ensureContextDecision } from "./context-sizing.js";
import { CONTENTION_COOLDOWN_MS, observeChatResidency } from "./context-sizing-adapt.js";
import { ContextSizingStore } from "./context-sizing-store.js";
import { EMBEDDER_VRAM, fakeFetchJson, referenceRuntime, RTX_5090 } from "./context-sizing.test-helper.js";

const ROOT = "http://127.0.0.1:11434";
const MODEL = "qwen3.6:27b";
const SIZED = 172_032;
let dir: string;
let now: number;
/** VRAM held outside Ollama per the driver (desktop, browser, a game). */
let externalVram: number | null;

const embedder = { name: "mxbai-embed-large:latest", size: EMBEDDER_VRAM, size_vram: EMBEDDER_VRAM };
const chat = (ctx: number, size: number, vram = size) => ({ name: MODEL, size, size_vram: vram, context_length: ctx });
const eval32b = { name: "eval-model:32b", size: 20e9, size_vram: 20e9 };

async function observe(rows: Array<{ size_vram: number }>): Promise<void> {
  const ollama = rows.reduce((sum, r) => sum + r.size_vram, 0);
  await observeChatResidency(ROOT, MODEL, {
    ps: async () => ({ models: rows }),
    gpuUsed: async () => (externalVram === null ? null : ollama + externalVram),
    now: () => now,
    store: new ContextSizingStore(join(dir, "local-context-sizing.json")),
  });
}

function persisted() {
  _resetContextSizingForTests();
  return contextSizingRecord(ROOT, MODEL);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lax-adapt-"));
  process.env.LAX_DATA_DIR = dir;
  now = 5_000_000;
  externalVram = 1.5e9;
  _resetContextSizingForTests();
  await ensureContextDecision(ROOT, MODEL, {
    deps: {
      fetchJson: fakeFetchJson(referenceRuntime()),
      gpu: async () => RTX_5090,
      store: new ContextSizingStore(join(dir, "local-context-sizing.json")),
      backgroundModels: async () => ["mxbai-embed-large"],
      kvCacheType: () => null,
      now: () => now,
    },
  });
  expect(appliedContext(ROOT, MODEL)).toBe(SIZED);
});

afterEach(() => {
  delete process.env.LAX_DATA_DIR;
  _resetContextSizingForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("verification", () => {
  it("marks the size verified once a load at it is fully GPU-resident", async () => {
    await observe([chat(SIZED, 27.4e9), embedder]);
    expect(persisted()).toMatchObject({ numCtx: SIZED, verification: "verified" });
  });

  it("steps the decision down for good when it spills with nothing else to blame", async () => {
    await observe([chat(SIZED, 27.4e9, 25.4e9), embedder]);
    const record = persisted();
    expect(record).toMatchObject({ verification: "stepped_down" });
    // 2 GB of spill at 68.8 KB/token: 147,456 is the first 8k step that sheds it.
    expect(record?.numCtx).toBe(139_264);
    expect(appliedContext(ROOT, MODEL)).toBe(139_264);
  });

  it("ignores a load it did not ask for (someone else loaded another size)", async () => {
    await observe([chat(65_536, 20.6e9, 10e9), embedder]);
    expect(persisted()).toMatchObject({ numCtx: SIZED, verification: "pending" });
  });
});

describe("contention", () => {
  it("steps down only for the contention, then back up after a quiet cooldown", async () => {
    await observe([chat(SIZED, 27.4e9, 22e9), embedder, eval32b]);
    const reduced = appliedContext(ROOT, MODEL)!;
    expect(reduced).toBeLessThan(SIZED);
    expect(contextSizingRecord(ROOT, MODEL)?.numCtx).toBe(SIZED); // the decision itself is untouched

    // Next request runs at the reduced size and fits while the eval model stays.
    now += 60_000;
    await observe([chat(reduced, 22e9), embedder, eval32b]);
    expect(appliedContext(ROOT, MODEL)).toBe(reduced);

    // The eval model unloads — but one quiet observation is not a cooldown.
    now += 60_000;
    await observe([chat(reduced, 22e9), embedder]);
    now += CONTENTION_COOLDOWN_MS - 1;
    await observe([chat(reduced, 22e9), embedder]);
    expect(appliedContext(ROOT, MODEL)).toBe(reduced);

    now += 1;
    await observe([chat(reduced, 22e9), embedder]);
    expect(appliedContext(ROOT, MODEL)).toBe(SIZED);
  });

  it("restarts the cooldown when the contention comes back — no ping-pong", async () => {
    await observe([chat(SIZED, 27.4e9, 22e9), embedder, eval32b]);
    const reduced = appliedContext(ROOT, MODEL)!;
    now += 60_000;
    await observe([chat(reduced, 22e9), embedder]);
    now += CONTENTION_COOLDOWN_MS - 60_000;
    await observe([chat(reduced, 22e9), embedder, eval32b]); // back again
    now += 120_000;
    await observe([chat(reduced, 22e9), embedder]);
    expect(appliedContext(ROOT, MODEL)).toBe(reduced);
  });

  it("treats VRAM held outside Ollama (a game, a browser) as contention, not a bad estimate", async () => {
    externalVram = 6e9;
    await observe([chat(SIZED, 27.4e9, 25.4e9), embedder]);
    expect(appliedContext(ROOT, MODEL)).toBeLessThan(SIZED);
    expect(persisted()).toMatchObject({ numCtx: SIZED, verification: "pending" });
  });

  it("without a driver reading, an unexplained spill is the estimate's fault", async () => {
    externalVram = null;
    await observe([chat(SIZED, 27.4e9, 25.4e9), embedder]);
    expect(persisted()?.verification).toBe("stepped_down");
  });

  it("does not count the background models it already left room for as contention", async () => {
    await observe([chat(SIZED, 27.4e9, 26e9), embedder]);
    // Spill with only the embedder loaded is the estimate's fault, not contention.
    expect(persisted()?.verification).toBe("stepped_down");
  });
});
