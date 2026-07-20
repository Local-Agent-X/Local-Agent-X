import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "lax-redirect-once-"));
process.env.LAX_DATA_DIR = dataDir;
const [{ opRedirectOnce }, { readCanonicalEvents }, { readOp, writeOp }] = await Promise.all([
  import("./control-api-redirect.js"), import("./store.js"), import("../ops/op-store.js"),
]);

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("opRedirectOnce", () => {
  it("records one redirect per ingress key while preserving latest-wins", () => {
    writeOp({
      id: "op-redirect-once", type: "freeform", task: "work", lane: "build",
      retryPolicy: {}, ownerId: "local-user", visibility: "private", status: "running",
      createdAt: new Date().toISOString(), attemptCount: 0, canonical: { state: "running" },
    } as never);

    expect(opRedirectOnce("op-redirect-once", "first", "telegram", "receipt-1").ok).toBe(true);
    expect(opRedirectOnce("op-redirect-once", "first", "telegram", "receipt-1").ok).toBe(true);
    expect(opRedirectOnce("op-redirect-once", "second", "telegram", "receipt-2").ok).toBe(true);

    const op = readOp("op-redirect-once")!;
    expect(op.canonical?.redirectInstruction?.text).toBe("second");
    expect(op.canonical?.redirectIngressKeys).toEqual(["receipt-1", "receipt-2"]);
    expect(readCanonicalEvents("op-redirect-once").filter(event => event.type === "redirect_received")).toHaveLength(2);
  });
});
