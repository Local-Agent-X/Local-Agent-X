import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isLocalModelQualificationBoot } from "./qualification-boot.js";

const SRC = dirname(fileURLToPath(import.meta.url));

function snapshot(path: string): unknown {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      return { kind: "link", target, targetState: snapshot(resolve(dirname(path), target)), mtimeMs: stat.mtimeMs };
    }
    if (stat.isDirectory()) {
      return {
        kind: "directory",
        mtimeMs: stat.mtimeMs,
        entries: readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]),
      };
    }
    return { kind: "file", mtimeMs: stat.mtimeMs, bytes: readFileSync(path).toString("base64") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("local-model qualification boot boundary", () => {
  it("requires the one exact opt-in value", () => {
    expect(isLocalModelQualificationBoot({})).toBe(false);
    expect(isLocalModelQualificationBoot({ LAX_LOCAL_MODEL_QUALIFICATION_BOOT: "0" })).toBe(false);
    expect(isLocalModelQualificationBoot({ LAX_LOCAL_MODEL_QUALIFICATION_BOOT: "true" })).toBe(false);
    expect(isLocalModelQualificationBoot({ LAX_LOCAL_MODEL_QUALIFICATION_BOOT: "1" })).toBe(true);
  });

  it("is consumed only at the enumerated external boot-mutation seams", () => {
    const consumers = sourceFiles(SRC)
      .filter((path) => !path.endsWith("qualification-boot.ts") && !path.endsWith("qualification-boot.test.ts"))
      .filter((path) => readFileSync(path, "utf8").includes("isLocalModelQualificationBoot"))
      .map((path) => relative(SRC, path).replaceAll("\\", "/"))
      .sort();

    expect(consumers).toEqual([
      "canonical-loop/soak-metrics.ts",
      "config.ts",
      "index.ts",
      "local-runtimes/cache.ts",
      "server/index.ts",
    ]);
  });

  it.each(["absent", "empty", "populated", "junction"] as const)(
    "does not touch a preexisting %s cwd workspace or manifest during config load",
    async (layout) => {
      const root = mkdtempSync(join(tmpdir(), "lax-qualification-repo-surface-"));
      const data = join(root, "owned-data");
      const configuredWorkspace = join(root, "owned-agent-workspace");
      const cwdWorkspace = join(root, "workspace");
      const manifest = join(root, "config", "app-manifest.json");
      const oldCwd = process.cwd();
      const oldEnv = {
        data: process.env.LAX_DATA_DIR,
        workspace: process.env.LAX_WORKSPACE,
        qualification: process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT,
      };
      mkdirSync(dirname(manifest), { recursive: true });
      writeFileSync(manifest, "manifest-sentinel", "utf8");
      if (layout === "empty") mkdirSync(cwdWorkspace);
      if (layout === "populated") {
        mkdirSync(cwdWorkspace);
        writeFileSync(join(cwdWorkspace, "user-file.txt"), "do-not-touch", "utf8");
      }
      if (layout === "junction") {
        const target = join(root, "junction-target");
        mkdirSync(target);
        writeFileSync(join(target, "user-file.txt"), "do-not-touch", "utf8");
        symlinkSync(target, cwdWorkspace, process.platform === "win32" ? "junction" : "dir");
      }
      const before = { workspace: snapshot(cwdWorkspace), manifest: snapshot(manifest) };
      try {
        process.env.LAX_DATA_DIR = data;
        process.env.LAX_WORKSPACE = configuredWorkspace;
        process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT = "1";
        process.chdir(root);
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect({ workspace: snapshot(cwdWorkspace), manifest: snapshot(manifest) }).toEqual(before);
      } finally {
        process.chdir(oldCwd);
        if (oldEnv.data === undefined) delete process.env.LAX_DATA_DIR;
        else process.env.LAX_DATA_DIR = oldEnv.data;
        if (oldEnv.workspace === undefined) delete process.env.LAX_WORKSPACE;
        else process.env.LAX_WORKSPACE = oldEnv.workspace;
        if (oldEnv.qualification === undefined) delete process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT;
        else process.env.LAX_LOCAL_MODEL_QUALIFICATION_BOOT = oldEnv.qualification;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
