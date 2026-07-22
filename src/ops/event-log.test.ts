/**
 * Regression: op-id path traversal (audit finding 6).
 *
 * opDir() joins an opId under ~/.lax/operations. The opId reaches this seam
 * from model-controlled surfaces — a minted id seeded by the op "type"
 * (op_submit_async) and op tools that pass a raw `op_id` (op_status/op_kill)
 * straight through readOp → opDir. A `..`/separator-laden id must NOT let
 * join() escape the operations root and read or create files elsewhere under
 * ~/.lax. opDir now asserts the resolved path stays strictly inside the root.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// event-log captures OPS_BASE from getLaxDir() at module load, so the env
// override must be in place BEFORE the dynamic import below.
const dataDir = mkdtempSync(join(tmpdir(), "lax-eventlog-"));
process.env.LAX_DATA_DIR = dataDir;

const { opDir } = await import("./event-log.js");

const OPS_ROOT = join(dataDir, "operations");

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("opDir — containment against traversal op ids", () => {
  it("rejects a parent-traversal op id and creates nothing outside the root", () => {
    const escapeProbe = join(dataDir, "operations-escape-probe");
    // ../operations-escape-probe/x resolves as a sibling of the ops root.
    expect(() => opDir("../operations-escape-probe/x")).toThrow(/escapes operations root/);
    expect(existsSync(escapeProbe)).toBe(false);
  });

  it("rejects a backslash-separator traversal (Windows-native escape vector)", () => {
    const escapeProbe = join(dataDir, "operations-escape-win");
    expect(() => opDir("..\\operations-escape-win\\x")).toThrow(/escapes operations root/);
    expect(existsSync(escapeProbe)).toBe(false);
  });

  it("rejects an op id that resolves to the operations root itself", () => {
    expect(() => opDir("")).toThrow(/operations root itself/);
    expect(() => opDir(".")).toThrow(/operations root itself/);
  });

  it("still resolves and creates a normal in-root op dir (no regression)", () => {
    const dir = opDir("op_freeform_deadbeefdeadbeef");
    expect(dir.startsWith(OPS_ROOT + sep)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});
