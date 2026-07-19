import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistryStore, type PluginRegistry } from "./registry-store.js";

const dirs: string[] = [];

function tempRegistryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-plugin-registry-"));
  dirs.push(dir);
  return join(dir, "registry.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("plugin registry persistence", () => {
  it.each(["write", "rename"])("keeps the valid target when an atomic %s fails", (stage) => {
    const path = tempRegistryPath();
    const original: PluginRegistry = {
      sample: { enabled: true, path: "/plugins/sample", entryHash: "a".repeat(64) },
    };
    writeFileSync(path, JSON.stringify(original), "utf-8");
    const store = createPluginRegistryStore(path, () => {
      throw new Error(`${stage} failed`);
    });

    expect(() => store.write({ ...original, sample: { ...original.sample, enabled: false } })).toThrow();
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(original);
  });

  it("ignores an interrupted temp file and continues from the committed registry", () => {
    const path = tempRegistryPath();
    const committed: PluginRegistry = {
      stable: { enabled: true, path: "/plugins/stable", entryHash: "b".repeat(64) },
    };
    writeFileSync(path, JSON.stringify(committed), "utf-8");
    writeFileSync(`${path}.tmp.interrupted`, "{partial", "utf-8");

    const store = createPluginRegistryStore(path);
    expect(store.read()).toEqual(committed);
    expect(existsSync(`${path}.tmp.interrupted`)).toBe(true);
  });

  it("refuses to replace a corrupt committed registry with an empty default", () => {
    const path = tempRegistryPath();
    writeFileSync(path, "{partial", "utf-8");
    const store = createPluginRegistryStore(path);

    expect(() => store.read()).toThrow("Plugin registry is invalid");
  });

  it("rejects malformed lifecycle entries instead of admitting unpinned state", () => {
    const path = tempRegistryPath();
    writeFileSync(path, JSON.stringify({ broken: { enabled: "yes", path: "" } }), "utf-8");

    expect(() => createPluginRegistryStore(path).read()).toThrow("Plugin registry is invalid");
  });
});
