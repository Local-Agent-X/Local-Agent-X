import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginRegistryStore,
  isPluginRegistryContentError,
  PluginRegistryUnavailableError,
  type PluginRegistry,
} from "./registry-store.js";

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
  it("treats only a typed missing file as an empty first-install registry", () => {
    const path = tempRegistryPath();
    expect(createPluginRegistryStore(path).read()).toEqual({});
  });

  it.each(["write", "rename"])("keeps the valid target when an atomic %s fails", (stage) => {
    const path = tempRegistryPath();
    const original: PluginRegistry = {
      sample: { enabled: true, path: "/plugins/sample", entryHash: "a".repeat(64) },
    };
    writeFileSync(path, JSON.stringify(original), "utf-8");
    const cause = Object.assign(new Error(`${stage} failed at private path`), { code: "EBUSY" });
    const store = createPluginRegistryStore(path, () => {
      throw cause;
    });

    try { store.write({ ...original, sample: { ...original.sample, enabled: false } }); throw new Error("expected write failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(PluginRegistryUnavailableError);
      expect(error).toMatchObject({ operation: "write", code: "EBUSY", cause });
    }
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

  it.each(["EAGAIN", "EBUSY", "EACCES", "ENOENT", "EPERM", "EMFILE"])("preserves typed cause and code for %s read unavailability", (code) => {
    const path = tempRegistryPath();
    writeFileSync(path, "{}", "utf-8");
    const cause = Object.assign(new Error("private path"), { code });
    const store = createPluginRegistryStore(path, undefined, () => { throw cause; });

    try { store.read(); throw new Error("expected read failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(PluginRegistryUnavailableError);
      expect(error).toMatchObject({ operation: "read", code, cause });
      expect((error as Error).message).not.toContain("private");
      expect(isPluginRegistryContentError(error)).toBe(false);
    }
  });

  it.each(["missing-to-valid", "valid-to-missing"] as const)("treats %s confirmation as unavailable", (transition) => {
    const path = tempRegistryPath();
    writeFileSync(path, "{}", "utf-8");
    let stats = 0;
    const missing = () => { throw Object.assign(new Error("private path"), { code: "ENOENT" }); };
    const store = createPluginRegistryStore(path, undefined, undefined, (target) => {
      stats += 1;
      if (transition === "missing-to-valid" && stats === 1) return missing();
      if (transition === "valid-to-missing" && stats === 3) return missing();
      return statSync(target);
    });

    expect(() => store.read()).toThrow("Plugin registry read is temporarily unavailable");
  });

  it("treats an unavailable confirmation read as unavailable rather than corrupt", () => {
    const path = tempRegistryPath();
    writeFileSync(path, "{broken", "utf-8");
    let reads = 0;
    const store = createPluginRegistryStore(path, undefined, (target, encoding) => {
      reads += 1;
      if (reads === 2) throw Object.assign(new Error("private path"), { code: "EMFILE" });
      return readFileSync(target, encoding);
    });

    expect(() => store.read()).toThrow("Plugin registry read is temporarily unavailable");
  });

  it("brands malformed durable content separately from transient I/O", () => {
    const path = tempRegistryPath();
    writeFileSync(path, '{"broken":', "utf-8");
    let error: unknown;
    try { createPluginRegistryStore(path).read(); } catch (caught) { error = caught; }
    expect(isPluginRegistryContentError(error)).toBe(true);
    expect(error).toMatchObject({ message: "Plugin registry is invalid", cause: expect.any(SyntaxError) });
  });
});
