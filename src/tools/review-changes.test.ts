// review_changes: the request's file changes, each diffed against what the file held
// before the request, read from the rollback store's earliest capture of each file.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const changes: Array<{ path: string; before: string | null }> = [];
vi.mock("../autonomy/rollback-rewind.js", () => ({ changesSinceOp: () => changes }));
vi.mock("../security/layer/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../security/layer/index.js")>()),
  loadFileAccessMode: () => "workspace",
  evaluateFileAccess: (_w: string, _m: string, _c: unknown, _a: string, path: string) => ({ allowed: !path.endsWith("secret.txt") }),
}));
vi.mock("../config.js", () => ({ getRuntimeConfig: () => ({ workspace: "/ws" }) }));

const { reviewChangesTool } = await import("./review-changes.js");
const call = (extra: Record<string, unknown> = {}) => reviewChangesTool.execute({ _sessionId: "s1", _operationId: "op1", ...extra });

let dir: string;
beforeEach(() => {
  changes.length = 0;
  dir = mkdtempSync(join(tmpdir(), "review-changes-"));
  return () => rmSync(dir, { recursive: true, force: true });
});

describe("review_changes", () => {
  it("diffs each changed file against its bytes from before the request", async () => {
    const edited = join(dir, "a.ts");
    const created = join(dir, "b.ts");
    writeFileSync(edited, "const a = 1;\nconst b = 3;\n");
    writeFileSync(created, "export {};\n");
    changes.push({ path: edited, before: "const a = 1;\nconst b = 2;\n" }, { path: created, before: null });
    const r = await call();
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("2 files changed for this request");
    expect(r.content).toContain(`${edited}: +1 -1`);
    expect(r.content).toContain("-const b = 2;");
    expect(r.content).toContain("+const b = 3;");
    expect(r.content).toContain(`${created} (new): +1 -0`);
  });

  it("leaves out a file changed back, names a deleted one, and never shows one the read gate refuses", async () => {
    const same = join(dir, "same.ts");
    const secret = join(dir, "secret.txt");
    writeFileSync(same, "x\n");
    writeFileSync(secret, "hunter2\n");
    changes.push({ path: same, before: "x\n" }, { path: join(dir, "gone.ts"), before: "y\n" }, { path: secret, before: "old\n" });
    const r = await call();
    expect(r.content).not.toContain("same.ts");
    expect(r.content).toContain("gone.ts: deleted");
    expect(r.content).toContain("secret.txt: changed (not readable here)");
    expect(r.content).not.toContain("hunter2");
  });

  it("says when nothing is on record, and needs a request to review", async () => {
    expect((await call()).content).toContain("No file changes from this request");
    expect((await reviewChangesTool.execute({})).isError).toBe(true);
  });
});
