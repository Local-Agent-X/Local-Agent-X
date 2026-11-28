// A strong model's `limit` is honored on a short file; any other model still
// gets a short file whole from its offset.
import { beforeEach, describe, expect, it, vi } from "vitest";

const models = new Map<string, string>();
vi.mock("../ops/op-store.js", () => ({ readOp: (id: string) => (models.has(id) ? { id, model: models.get(id) } : null) }));
vi.mock("../canonical-loop/public/op-facts.js", () => ({ resolveOpModel: (op: { model?: string }) => op.model }));

const { linesToRead } = await import("./read-range.js");

const call = (op: string | undefined, limit?: number) => ({ path: "spec.html", ...(limit !== undefined ? { limit } : {}), ...(op ? { _operationId: op } : {}) });

beforeEach(() => {
  models.clear();
  models.set("op-strong", "claude-fable-5-2");
  models.set("op-weak", "gemma4:9b");
});

describe("linesToRead", () => {
  it("gives a strong model the 75 lines it asked for from a 671-line file", () => {
    expect(linesToRead(671, 327, call("op-strong", 75))).toBe(75);
  });

  it("still returns a short file whole from the offset to a weak model", () => {
    expect(linesToRead(671, 327, call("op-weak", 75))).toBe(344);
  });

  it("returns a short file whole when the model cannot be told", () => {
    expect(linesToRead(671, 327, call(undefined, 75))).toBe(344);
    expect(linesToRead(671, 327, call("op-gone", 75))).toBe(344);
  });

  it("honors any model's limit on a long file, and never runs past the end", () => {
    expect(linesToRead(5_000, 0, call("op-weak", 200))).toBe(200);
    expect(linesToRead(5_000, 4_950, call("op-weak", 200))).toBe(50);
  });

  it("without a limit, the rest of the file", () => {
    expect(linesToRead(671, 0, call("op-strong"))).toBe(671);
  });
});
