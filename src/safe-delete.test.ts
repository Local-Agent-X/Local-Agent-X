// App recycle bin. Proves a destructive op moves user data into ~/.lax/trash
// (recoverable) instead of perma-deleting it.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { moveToTrash, trashRecord } from "./safe-delete.js";

let laxDir: string;
let workDir: string;
const prevEnv = process.env.LAX_DATA_DIR;

beforeEach(() => {
  laxDir = mkdtempSync(join(tmpdir(), "lax-trash-"));
  workDir = mkdtempSync(join(tmpdir(), "lax-work-"));
  process.env.LAX_DATA_DIR = laxDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  for (const d of [laxDir, workDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe("safe-delete recycle bin", () => {
  it("moves a file into ~/.lax/trash and removes it from the source", async () => {
    const f = join(workDir, "note.txt");
    writeFileSync(f, "important", "utf-8");
    const dest = await moveToTrash(f, "test");
    expect(dest).toBeTruthy();
    expect(existsSync(f)).toBe(false);                          // gone from source
    expect(existsSync(dest!)).toBe(true);                       // recoverable in trash
    expect(dest!.startsWith(join(laxDir, "trash"))).toBe(true); // under the recycle bin
  });

  it("moves a directory (an app) recursively", async () => {
    const app = join(workDir, "my-app");
    mkdirSync(app);
    writeFileSync(join(app, "index.html"), "<h1>hi</h1>", "utf-8");
    const dest = await moveToTrash(app, "app_delete");
    expect(existsSync(app)).toBe(false);
    expect(existsSync(join(dest!, "index.html"))).toBe(true);
  });

  it("returns null for a path that doesn't exist", async () => {
    expect(await moveToTrash(join(workDir, "missing"))).toBeNull();
  });

  it("snapshots a deleted config record (project/agent) as recoverable JSON", () => {
    const proj = { id: "proj-abc", name: "My Project", agentIds: ["a1", "a2"] };
    trashRecord(`project-${proj.id}`, proj);
    const trashDir = join(laxDir, "trash");
    const snaps = readdirSync(trashDir)
      .flatMap((d) => readdirSync(join(trashDir, d)).map((f) => join(trashDir, d, f)))
      .filter((f) => f.includes("project-proj-abc") && f.endsWith(".json"));
    expect(snaps.length).toBe(1);
    expect(JSON.parse(readFileSync(snaps[0], "utf-8"))).toEqual(proj);
  });
});
