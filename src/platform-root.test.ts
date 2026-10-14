import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { platformRoot } from "./platform-root.js";

describe("platformRoot", () => {
  it("is the checkout holding this package's config/ and public/", () => {
    const root = platformRoot();
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name).toBe("local-agent-x");
    expect(existsSync(join(root, "config", "system-prompt.md"))).toBe(true);
    expect(existsSync(join(root, "public", "app.html"))).toBe(true);
  });
});

// One module answers "where is LAX installed". Every other derivation from
// import.meta.dirname silently became cwd-relative under a CJS interop load
// (tsx, createRequire): the config loader read config/ beside the cwd's
// parent and fell back to an empty system prompt, the manifest wrote to
// C:\Users\config. A new site fails here until it asks platformRoot().
describe("one derivation of the install root", () => {
  const SRC = join(platformRoot(), "src");
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return sourceFiles(p);
      return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });

  it("no source file outside platform-root.ts reads import.meta.dirname", () => {
    const offenders = sourceFiles(SRC)
      .filter((p) => !p.endsWith("platform-root.ts") && readFileSync(p, "utf8").includes("import.meta.dirname"))
      .map((p) => p.slice(SRC.length + 1).split("\\").join("/"));
    expect(offenders).toEqual([]);
  });
});
