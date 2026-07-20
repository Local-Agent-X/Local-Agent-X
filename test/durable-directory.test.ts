import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _setDirectorySyncHookForTests,
  ensureDurableDirectory,
} from "../src/persistence/durable-directory.js";
import { updateDurableJsonl } from "../src/persistence/durable-jsonl.js";

let root = "";
afterEach(() => {
  _setDirectorySyncHookForTests(null);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("durable directory publication", () => {
  it("fsyncs each parent while creating a nested hierarchy", () => {
    root = mkdtempSync(join(tmpdir(), "durable-dir-"));
    const synced: string[] = [];
    _setDirectorySyncHookForTests((path) => synced.push(path));
    expect(ensureDurableDirectory(join(root, "one", "two"))).toBe(true);
    expect(synced).toEqual([resolve(root), resolve(root, "one")]);
  });

  it("fsyncs the parent of a newly created JSONL file after file fsync", () => {
    root = mkdtempSync(join(tmpdir(), "durable-file-"));
    const synced: string[] = [];
    const path = join(root, "action", "nested", "events.jsonl");
    _setDirectorySyncHookForTests((directory) => synced.push(directory));
    updateDurableJsonl(path, (value): value is { ok: boolean } =>
      !!value && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean",
    () => ({ ok: true }));
    expect(synced).toEqual([
      resolve(root), resolve(root, "action"), resolve(root, "action", "nested"),
    ]);
  });
});
