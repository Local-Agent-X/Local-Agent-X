/**
 * The universal-index binding must never be stolen by a TRANSIENT MemoryIndex.
 * Every MemoryIndex attaches itself as the universal index from its
 * constructor; the context-pack fallback constructs a short-lived index in the
 * same process, and pre-fix its constructor attach rebound the singleton over
 * the server's live index — then closed, turning universal write-through into
 * a silent no-op. The attach now yields to an existing OPEN binding; a closed
 * binding is dead weight and is replaced, so a standalone process (no live
 * index) still binds normally.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { getUniversalIndex } from "./universal-index.js";

const dirs: string[] = [];
const opened: MemoryIndex[] = [];

function makeIndex(): MemoryIndex {
  const dir = mkdtempSync(join(tmpdir(), "lax-ui-attach-"));
  dirs.push(dir);
  const memory = new MemoryIndex(dir);
  opened.push(memory);
  return memory;
}

afterEach(() => {
  for (const m of opened.splice(0)) { try { m.close(); } catch {} }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

/** The constructor attach lands via a dynamic import — give it real ticks. */
const attachSettled = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

describe("universal-index constructor attach", () => {
  it("an open binding survives a transient's construction and close; with nothing open the next index binds", async () => {
    const live = makeIndex();
    await vi.waitFor(() => expect(getUniversalIndex()?.getMemory()).toBe(live));

    // The context-pack fallback shape: construct + close within the same
    // process while the long-lived index is open. No steal at either point.
    const transient = makeIndex();
    await attachSettled();
    expect(getUniversalIndex()?.getMemory()).toBe(live);
    transient.close();
    await attachSettled();
    expect(getUniversalIndex()?.getMemory()).toBe(live);
    expect(live.isOpen()).toBe(true);

    // Standalone-process shape: nothing open → the next construction binds.
    live.close();
    const next = makeIndex();
    await vi.waitFor(() => expect(getUniversalIndex()?.getMemory()).toBe(next));
  });
});
