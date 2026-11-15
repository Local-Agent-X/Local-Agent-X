import { beforeEach, describe, expect, it, vi } from "vitest";

import { dropReady, readyUpdate, stageReady, takeReady, type StagedUpdate } from "./update-staging.js";

const gate = { ok: true, skipped: false, durationMs: 0, detail: "" };
const candidate = (target: string): StagedUpdate => ({
  route: "rolling", base: "a", target, preparedAt: 0, extractDir: `/x/${target}`, version: target,
  depsChanged: false, desktopDepsChanged: false, gates: { deps: gate, build: gate, bind: gate, smoke: gate },
});

beforeEach(() => { takeReady(); });

describe("the prepared-update slot", () => {
  it("keeps the newest: a newer candidate replaces the older, which is discarded", async () => {
    const discard = vi.fn(async () => {});
    await stageReady(candidate("b"), discard);
    expect(discard).not.toHaveBeenCalled();
    await stageReady(candidate("c"), discard);
    expect(readyUpdate()?.target).toBe("c");
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(expect.objectContaining({ target: "b" }));
  });

  it("hands the ready candidate to landing once and empties the slot", async () => {
    await stageReady(candidate("b"), async () => {});
    expect(takeReady()?.target).toBe("b");
    expect(takeReady()).toBeNull();
  });

  it("a failed discard does not keep the newer one out", async () => {
    await stageReady(candidate("b"), async () => {});
    await stageReady(candidate("c"), async () => { throw new Error("busy"); });
    expect(readyUpdate()?.target).toBe("c");
  });

  it("drops a candidate that can no longer land and removes its files", async () => {
    const discard = vi.fn(async () => {});
    await stageReady(candidate("b"), discard);
    await dropReady(discard);
    expect(readyUpdate()).toBeNull();
    expect(discard).toHaveBeenCalledWith(expect.objectContaining({ target: "b" }));
  });
});
