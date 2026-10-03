import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bulkReplaceTool } from "./edit-tools.js";
import { platformRoot } from "../platform-root.js";

// End-to-end through the REAL bulk_replace tool: multi-file find/replace with
// verifiable per-file counts — the tool-native form of `sed -i` over a tree.
// Absolute temp paths, no model, no mocks.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-bulk-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "alpha beta alpha\n");
  writeFileSync(join(dir, "sub", "b.txt"), "alpha\n");
  writeFileSync(join(dir, "c.md"), "gamma only\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("bulkReplaceTool", () => {
  it("replaces every occurrence across matching files and reports per-file counts", async () => {
    const r = await bulkReplaceTool.execute({ path: dir, old_string: "alpha", new_string: "omega" });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("Replaced 3 occurrence(s) across 2 file(s)");
    expect(String(r.content)).toContain("a.txt: 2");
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("omega beta omega\n");
    expect(readFileSync(join(dir, "sub", "b.txt"), "utf-8")).toBe("omega\n");
    expect(readFileSync(join(dir, "c.md"), "utf-8")).toBe("gamma only\n");
  });

  it("dry_run reports counts without writing", async () => {
    const r = await bulkReplaceTool.execute({ path: dir, old_string: "alpha", new_string: "omega", dry_run: true });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("Would replace 3 occurrence(s)");
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("alpha beta alpha\n");
  });

  it("honors the glob filter", async () => {
    writeFileSync(join(dir, "d.md"), "alpha\n");
    const r = await bulkReplaceTool.execute({ path: dir, glob: "**/*.md", old_string: "alpha", new_string: "omega" });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("across 1 file(s)");
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("alpha beta alpha\n"); // .txt untouched
    expect(readFileSync(join(dir, "d.md"), "utf-8")).toBe("omega\n");
  });

  it("REFUSES when nothing matches — 0 matches is an error, not silent success", async () => {
    const r = await bulkReplaceTool.execute({ path: dir, old_string: "nope-not-here", new_string: "x" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("not found");
  });

  it("skips sensitive-pattern files inside the tree and says so", async () => {
    writeFileSync(join(dir, ".env"), "alpha=1\n");
    const r = await bulkReplaceTool.execute({ path: dir, old_string: "alpha", new_string: "omega" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, ".env"), "utf-8")).toBe("alpha=1\n");
    expect(String(r.metadata?.recovery ?? "")).toContain(".env");
  });

  it("leaves the app's control files it finds in the tree alone, and says so", async () => {
    // The gates that refuse settings.json and ask about hooks.json see only
    // the root this call names, never what the scan discovers under it.
    mkdirSync(join(dir, ".lax", "plugins"), { recursive: true });
    for (const rel of ["settings.json", "hooks.json", join("plugins", "registry.json")]) writeFileSync(join(dir, ".lax", rel), "alpha\n");
    const r = await bulkReplaceTool.execute({ path: dir, old_string: "alpha", new_string: "omega" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("omega beta omega\n");
    for (const rel of ["settings.json", "hooks.json", join("plugins", "registry.json")]) {
      expect(readFileSync(join(dir, ".lax", rel), "utf-8"), rel).toBe("alpha\n");
      expect(String(r.metadata?.recovery ?? ""), rel).toContain(`${join(".lax", rel)} (app control file)`);
    }
  });

  // Windows opens the same folder through each of these spellings, and the
  // scan returns paths under the root as the call spelled it.
  async function replaceUnder(spelling: string): Promise<void> {
    mkdirSync(join(dir, ".lax", "uploads"));
    const own = join("uploads", "notes.md");
    for (const rel of ["settings.json", "hooks.json", "notes.md", own]) writeFileSync(join(dir, ".lax", rel), "alpha\n");
    const r = await bulkReplaceTool.execute({ path: join(dir, spelling), old_string: "alpha", new_string: "omega" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, ".lax", own), "utf-8")).toBe("omega\n");
    for (const rel of ["settings.json", "hooks.json", "notes.md"]) expect(readFileSync(join(dir, ".lax", rel), "utf-8"), rel).toBe("alpha\n");
  }

  it.skipIf(process.platform !== "win32")("knows the data dir by a stream suffix too", async () => {
    mkdirSync(join(dir, ".lax"));
    await replaceUnder(".lax::$INDEX_ALLOCATION");
  });

  it.skipIf(process.platform !== "win32")("knows the data dir by its 8.3 short name too, where the volume keeps them", async (t) => {
    mkdirSync(join(dir, ".lax"));
    const short = join(dir, "LAX~1");
    if (!existsSync(short) || realpathSync.native(short) !== realpathSync.native(join(dir, ".lax"))) return t.skip();
    await replaceUnder("LAX~1");
  });

  // The gate refuses writes inside the install, but it only sees this call's
  // root, and a root above the install is not inside it. The REAL install,
  // read only: dry_run and a string package.json cannot contain, so a missing
  // skip shows up as an unreported scan, never as a rewritten file.
  it("leaves files in the Local Agent X install folder alone under a root above it, and says so", async () => {
    const install = platformRoot();
    const r = await bulkReplaceTool.execute({
      path: dirname(install), glob: `${basename(install)}/package.json`,
      old_string: `lax-bulk-probe-${process.pid}-${Date.now()}`, new_string: "x", dry_run: true,
    });
    expect(String(r.metadata?.recovery ?? "")).toContain(`${join(basename(install), "package.json")} (Local Agent X install folder)`);
  });

  // config/ is the agent's own instructions, loaded into every chat, and
  // changes only through self_edit in developer mode, so a scan rooted in it
  // rewrites none of it. Same probe: dry_run and a string no file there can
  // contain.
  it("leaves every file in the install's config/ alone as the install folder, and says so", async () => {
    const config = join(platformRoot(), "config");
    const r = await bulkReplaceTool.execute({
      path: config, glob: "*",
      old_string: `lax-bulk-probe-${process.pid}-${Date.now()}`, new_string: "x", dry_run: true,
    });
    const recovery = String(r.metadata?.recovery ?? "");
    const names = readdirSync(config, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["system-prompt.md", "tools.json", "protected-files.json"]));
    for (const name of names) expect(recovery, name).toContain(`${name} (Local Agent X install folder)`);
  });

  it("a control file named as the path itself is the gates' to judge, not skipped", async () => {
    mkdirSync(join(dir, ".lax"));
    writeFileSync(join(dir, ".lax", "hooks.json"), "alpha\n");
    const r = await bulkReplaceTool.execute({ path: join(dir, ".lax", "hooks.json"), old_string: "alpha", new_string: "omega" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, ".lax", "hooks.json"), "utf-8")).toBe("omega\n");
  });

  it("matches CRLF files when old_string was quoted with LF", async () => {
    writeFileSync(join(dir, "win.txt"), "one\r\ntwo\r\nthree\r\n");
    const r = await bulkReplaceTool.execute({ path: dir, glob: "win.txt", old_string: "one\ntwo", new_string: "uno\ndos" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, "win.txt"), "utf-8")).toBe("uno\r\ndos\r\nthree\r\n");
  });

  it("accepts a single FILE as the path", async () => {
    const r = await bulkReplaceTool.execute({ path: join(dir, "a.txt"), old_string: "beta", new_string: "delta" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("alpha delta alpha\n");
  });
});
