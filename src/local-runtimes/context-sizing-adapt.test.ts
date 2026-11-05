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

describe("paging that /api/ps does not report", () => {
  // Ollama reports the runner at less than it holds (qwen3.8 27B: 18 GB
  // reported, ~28 GB held), so the driver's reading is given directly here,
  // never derived from the rows.
  const TOTAL = RTX_5090.totalBytes;
  async function reply(rows: Array<{ size_vram: number }>, freeBytes: number | null, tokPerSec: number, tokens = 240, contextTokens = 0): Promise<void> {
    await observeChatResidency(ROOT, MODEL, {
      ps: async () => ({ models: rows }),
      gpuUsed: async () => (freeBytes === null ? null : TOTAL - freeBytes),
      now: () => now,
      store: new ContextSizingStore(join(dir, "local-context-sizing.json")),
    }, { tokens, durationNs: (tokens / tokPerSec) * 1e9, contextTokens });
  }
  const resident = [chat(SIZED, 18e9), embedder];

  it("keeps the fastest fully resident decode as the yardstick, and ignores a reply too short to time", async () => {
    await reply(resident, 4e9, 120);
    await reply(resident, 4e9, 300, 20);
    expect(persisted()).toMatchObject({ verification: "verified", healthyDecodeTokPerSec: 120 });
  });

  it("steps down when a reply decodes far below it on a full card, and back once the card has room again", async () => {
    await reply(resident, 4e9, 120);
    await reply(resident, 0.8e9, 21);
    const reduced = appliedContext(ROOT, MODEL)!;
    expect(reduced).toBeLessThan(SIZED);
    expect(contextSizingRecord(ROOT, MODEL)?.numCtx).toBe(SIZED); // the decision itself is untouched

    // Reloaded smaller it runs at speed, but whatever filled the card is still there.
    const smaller = [chat(reduced, 16e9), embedder];
    now += 60_000;
    await reply(smaller, 2.5e9, 120);
    now += CONTENTION_COOLDOWN_MS;
    await reply(smaller, 2.5e9, 120);
    expect(appliedContext(ROOT, MODEL)).toBe(reduced);

    // It goes; the card has room for the size given back, for a full cooldown.
    now += 60_000;
    await reply(smaller, 8e9, 120);
    now += CONTENTION_COOLDOWN_MS;
    await reply(smaller, 8e9, 120);
    expect(appliedContext(ROOT, MODEL)).toBe(SIZED);
  });

  it("lifts once the co-loaded model is gone, though the card never had a whole margin free (live 2026-11-03)", async () => {
    // Decided 155,648 had 2.7 GB free; stepped to 122,880 with the 8B gone it had 5.0 GB.
    await reply(resident, 2.7e9, 101);
    await reply(resident, 0.95e9, 45);
    const reduced = appliedContext(ROOT, MODEL)!;
    expect(reduced).toBeLessThan(SIZED);
    const smaller = [chat(reduced, 16e9), embedder];
    await reply(smaller, 5e9, 101);
    now += CONTENTION_COOLDOWN_MS;
    await reply(smaller, 5e9, 101);
    expect(appliedContext(ROOT, MODEL)).toBe(SIZED);
  });

  it("steps down again when the first step was not enough", async () => {
    await reply(resident, 4e9, 120);
    await reply(resident, 0.8e9, 21);
    const first = appliedContext(ROOT, MODEL)!;
    await reply([chat(first, 16e9), embedder], 0.5e9, 20);
    expect(appliedContext(ROOT, MODEL)).toBeLessThan(first);
  });

  it("does not step down for a slow reply on a card with room: a busy GPU is not a full one", async () => {
    await reply(resident, 4e9, 120);
    await reply(resident, 4e9, 21);
    expect(appliedContext(ROOT, MODEL)).toBe(SIZED);
  });

  it("does not act on the decode alone: without a driver reading a long context could be the cause", async () => {
    await reply(resident, 4e9, 120);
    await reply(resident, null, 21);
    expect(appliedContext(ROOT, MODEL)).toBe(SIZED);
  });

  it("catches a milder 2x slowdown (a co-loaded 8B: 97 -> 46 tok/s), and lets 1.5x from a long context pass", async () => {
    await reply(resident, 4e9, 97);
    await reply(resident, 0.9e9, 65);
    expect(appliedContext(ROOT, MODEL)).toBe(SIZED);
    await reply(resident, 0.9e9, 46);
    expect(appliedContext(ROOT, MODEL)).toBeLessThan(SIZED);
  });

  it("does not read a deep prompt's slower decode as paging (live 2026-11-05: 186 tok/s 1k deep, 88 at 48.7k)", async () => {
    await reply(resident, 4e9, 186, 96, 1_407);
    await reply(resident, 1.0e9, 88, 161, 48_747);
    expect(appliedContext(ROOT, MODEL)).toBe(SIZED);
  });

  it("still catches paging deep in a prompt (live 2026-11-05: 4 tok/s 18k deep)", async () => {
    await reply(resident, 4e9, 186, 96, 1_407);
    await reply(resident, 0.8e9, 4, 89, 18_431);
    expect(appliedContext(ROOT, MODEL)).toBeLessThan(SIZED);
  });

  it("keeps a deep reply's rate as a yardstick scaled to an empty prompt", async () => {
    await reply(resident, 4e9, 100, 240, 56_000);
    expect(persisted()?.healthyDecodeTokPerSec).toBe(200);
  });

  it("has no yardstick before a fully resident reply, so a first slow reply changes nothing", async () => {
    await reply(resident, 0.8e9, 21);
    expect(appliedContext(ROOT, MODEL)).toBe(SIZED);
    expect(persisted()?.healthyDecodeTokPerSec).toBe(21);
  });
});
