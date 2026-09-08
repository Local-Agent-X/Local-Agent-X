import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "./read-write-tools.js";

// Live failure 2026-09-08: a local model read an app directory, got back
// "EISDIR: illegal operation on a directory, read", learned nothing from it,
// and spent thirteen near-identical `find` calls before the turn collapsed.
// The recovery has to be IN the error, at the moment the model is looking.
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-readdir-"));
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "index.html"), "<footer>hi</footer>");
  writeFileSync(join(dir, "app", "styles.css"), "body{}");
  mkdirSync(join(dir, "empty"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function read(path: string) {
  return (await readTool.execute({ path })) as {
    status?: string;
    content?: string;
    metadata?: { isDirectory?: boolean; entries?: string[] };
  };
}

describe("read on a directory", () => {
  it("says it is a directory instead of surfacing EISDIR", async () => {
    const r = await read(join(dir, "app"));
    expect(r.content).toContain("is a directory, not a file");
    expect(r.content).not.toContain("EISDIR");
  });

  it("hands back the listing, so recovery costs no extra call", async () => {
    const r = await read(join(dir, "app"));
    expect(r.content).toContain("index.html");
    expect(r.content).toContain("styles.css");
    expect(r.metadata?.isDirectory).toBe(true);
    expect(r.metadata?.entries).toEqual(expect.arrayContaining(["index.html", "styles.css"]));
  });

  it("names the next action", async () => {
    const r = await read(join(dir, "app"));
    expect(r.content).toMatch(/glob/);
  });

  it("handles an empty directory without claiming contents", async () => {
    const r = await read(join(dir, "empty"));
    expect(r.content).toContain("is empty");
  });

  it("still reads an ordinary file", async () => {
    const r = await read(join(dir, "app", "index.html"));
    expect(r.content).toContain("<footer>hi</footer>");
  });
});
