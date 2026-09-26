// delete_file on a folder: the whole folder goes to the app trash and
// restore_file brings it back (Peter, 2026-09-25: "recovering a whole folder is
// important"). The containment refusals are exercised through the pure
// function with temp roots, so no test ever aims a delete at a real workspace.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prevData = process.env.LAX_DATA_DIR;
let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "lax-delete-folder-")));
  process.env.LAX_DATA_DIR = join(base, "lax-data");
  mkdirSync(process.env.LAX_DATA_DIR, { recursive: true });
});
afterAll(() => {
  if (prevData === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevData;
  rmSync(base, { recursive: true, force: true });
});

function tree(root: string): void {
  mkdirSync(join(root, "chunks", "deep"), { recursive: true });
  writeFileSync(join(root, "manifest.json"), '{"n":3}');
  writeFileSync(join(root, "chunks", "a.js"), "a");
  writeFileSync(join(root, "chunks", "deep", "b.js"), "b");
}

describe("delete_file on a folder — whole, to the trash, restorable", () => {
  it("moves the folder to the app trash, says how to restore it, and restore_file brings it all back", async () => {
    const { deleteFileTool } = await import("./read-write-tools.js");
    const { restoreDeleted } = await import("../trash-restore.js");
    const dir = join(base, "work", "build-cache");
    tree(dir);

    const r = await deleteFileTool.execute({ path: dir });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("Deleted the folder");
    expect(String(r.content)).toContain("3 files");
    expect(String(r.content)).toContain("restore_file");
    expect(existsSync(dir)).toBe(false);

    const back = restoreDeleted(dir);
    expect(back).toMatchObject({ restored: dir, tier: "lax" });
    expect(readFileSync(join(dir, "chunks", "deep", "b.js"), "utf8")).toBe("b");
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe('{"n":3}');
  });
});

describe("folderDeleteRefusal — the folders no card can make safe", () => {
  it("refuses the workspace root and its ancestors, the install, the data dir, protected files, apps; allows an ordinary subfolder", async () => {
    const { folderDeleteRefusal } = await import("./delete-folder.js");
    const ws = join(base, "roots", "home", "workspace");
    const platform = join(base, "roots", "install");
    const laxData = join(base, "roots", "home", ".lax");
    for (const d of [join(ws, "client-data", "build-cache"), join(ws, "apps", "calendar", "src"), join(platform, "src", "security"), laxData]) mkdirSync(d, { recursive: true });
    const roots = { workspace: ws, platform, laxData, home: join(base, "roots", "home"), protectedPaths: [join(platform, "src", "security")] };

    expect(folderDeleteRefusal(ws, roots)).toMatch(/workspace root/);
    expect(folderDeleteRefusal(join(base, "roots", "home"), roots)).toMatch(/workspace root|data folder|home/);
    expect(folderDeleteRefusal(platform, roots)).toMatch(/installation/);
    expect(folderDeleteRefusal(join(platform, "src"), roots)).toMatch(/protected file/);
    expect(folderDeleteRefusal(laxData, roots)).toMatch(/data folder/);
    expect(folderDeleteRefusal(join(ws, "apps", "calendar"), roots)).toMatch(/app_delete\(\{ id: "calendar" \}\)/);
    expect(folderDeleteRefusal(join(ws, "apps", "calendar", "src"), roots)).toBeNull();
    expect(folderDeleteRefusal(join(ws, "client-data", "build-cache"), roots)).toBeNull();
    expect(folderDeleteRefusal(join(ws, "client-data"), roots)).toBeNull();
  });

  it("counts files with a cap", async () => {
    const { folderFileCount } = await import("./delete-folder.js");
    const d = join(base, "count");
    tree(d);
    expect(folderFileCount(d)).toBe("3");
    expect(folderFileCount(join(base, "nope"))).toBe("0");
  });
});
