import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtomicWriteOperations } from "../util/json-store.js";
import {
  ENTITY_PAGE_RETRY_DELAYS_MS, _pendingEntityPageRebuilds, _resetEntityPageRebuilds, writeEntityPage,
} from "./entity-page-write.js";

let dir: string;
let page: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-entity-page-"));
  page = join(dir, "peter.md");
  writeFileSync(page, "# Peter\n");
});

afterEach(() => {
  _resetEntityPageRebuilds();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const busy = (): Error => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

/** Write operations whose rename is refused the next `times` attempts. */
function refusingRenames(times: { left: number }): AtomicWriteOperations {
  return {
    write: (path, data) => writeFileSync(path, data),
    rename: (from, to) => {
      if (times.left > 0) { times.left--; throw busy(); }
      writeFileSync(to, readFileSync(from));
      rmSync(from);
    },
    unlink: (path) => rmSync(path, { force: true }),
    wait: () => {},
  };
}

describe("a busy entity page is rebuilt later instead of failing the save", () => {
  it("writes at once when the file is free", () => {
    expect(writeEntityPage(page, "# Peter\n- one\n", () => { throw new Error("not needed"); })).toBe(true);
    expect(readFileSync(page, "utf8")).toBe("# Peter\n- one\n");
    expect(_pendingEntityPageRebuilds()).toEqual([]);
  });

  it("returns instead of throwing, and the rebuild runs on a later timer", () => {
    vi.useFakeTimers();
    // Every try of the first write is refused (its own short retries included).
    const refusals = { left: 100 };
    const rebuild = vi.fn(() => { writeEntityPage(page, "# Peter\n- rebuilt\n", rebuild); });
    expect(writeEntityPage(page, "# Peter\n- new\n", rebuild, refusingRenames(refusals))).toBe(false);
    expect(_pendingEntityPageRebuilds()).toEqual([page]);
    expect(rebuild).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ENTITY_PAGE_RETRY_DELAYS_MS[0]);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(readFileSync(page, "utf8")).toBe("# Peter\n- rebuilt\n");
    expect(_pendingEntityPageRebuilds()).toEqual([]);
  });

  it("keeps one timer per page, running the newest rebuild", () => {
    vi.useFakeTimers();
    const older = vi.fn();
    const newer = vi.fn();
    writeEntityPage(page, "a", older, refusingRenames({ left: 100 }));
    writeEntityPage(page, "b", newer, refusingRenames({ left: 100 }));
    vi.advanceTimersByTime(ENTITY_PAGE_RETRY_DELAYS_MS[0]);
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(1);
  });

  it("drops a waiting rebuild once a later save writes the page", () => {
    vi.useFakeTimers();
    const waiting = vi.fn();
    writeEntityPage(page, "a", waiting, refusingRenames({ left: 100 }));
    expect(writeEntityPage(page, "# Peter\n- latest\n", vi.fn())).toBe(true);
    vi.advanceTimersByTime(ENTITY_PAGE_RETRY_DELAYS_MS[ENTITY_PAGE_RETRY_DELAYS_MS.length - 1]);
    expect(waiting).not.toHaveBeenCalled();
    expect(_pendingEntityPageRebuilds()).toEqual([]);
  });

  it("stops after the last delay while the page stays busy", () => {
    vi.useFakeTimers();
    const rebuild = vi.fn(() => { writeEntityPage(page, "x", rebuild, refusingRenames({ left: 100 })); });
    writeEntityPage(page, "x", rebuild, refusingRenames({ left: 100 }));
    for (const delay of ENTITY_PAGE_RETRY_DELAYS_MS) vi.advanceTimersByTime(delay);
    expect(rebuild).toHaveBeenCalledTimes(ENTITY_PAGE_RETRY_DELAYS_MS.length);
    expect(_pendingEntityPageRebuilds()).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(rebuild).toHaveBeenCalledTimes(ENTITY_PAGE_RETRY_DELAYS_MS.length);
  });

  it("still throws a failure that is not a busy file", () => {
    const broken: AtomicWriteOperations = {
      write: () => { throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }); },
      rename: () => {},
      unlink: () => {},
    };
    expect(() => writeEntityPage(page, "x", vi.fn(), broken)).toThrow(/ENOSPC/);
    expect(_pendingEntityPageRebuilds()).toEqual([]);
  });

  // What happened in the live app: the previous save's re-index read of the
  // page is still in flight in this process when the next save writes it.
  // Windows refuses the swap, and the write's synchronous retry blocks the very
  // event loop that read needs to close the file (2026-11-12, 200 of 200).
  it.runIf(process.platform === "win32")("survives an in-flight read of the page in this process", async () => {
    const ROUNDS = 20;
    let refused = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const reading = readFile(page, "utf8").catch(() => null);
      await new Promise((resolve) => setImmediate(resolve));
      // Never throws; a refused write leaves a rebuild waiting.
      const written = writeEntityPage(page, `# Peter\n- round ${i}\n`, () => {
        writeEntityPage(page, `# Peter\n- rebuilt ${i}\n`, () => {});
      });
      if (!written) refused++;
      await reading;
    }
    expect(refused).toBeGreaterThan(0);
    // Give the waiting rebuild its first try with no read in flight.
    await new Promise((resolve) => setTimeout(resolve, ENTITY_PAGE_RETRY_DELAYS_MS[1] + 200));
    // The page ends current, written either by the last round or by the
    // rebuild that round left waiting, and nothing is left waiting.
    expect(readFileSync(page, "utf8")).toMatch(new RegExp(`^# Peter\\n- (round|rebuilt) ${ROUNDS - 1}\\n$`));
    expect(_pendingEntityPageRebuilds()).toEqual([]);
  });
});
