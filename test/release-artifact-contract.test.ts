import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSourceArchive } from "../scripts/build-source-archive.mjs";

const sha = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
const version = "0.0.0-contract";
const prefix = `local-agent-x-${version}`;

let outDir: string;
let assetPath: string;
let entries: string[];

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "versioned-source-"));
  assetPath = buildSourceArchive(sha, join(outDir, `${prefix}.tar.gz`), prefix);
  entries = execFileSync("tar", ["tzf", assetPath], { encoding: "utf-8" })
    .trim()
    .split(/\r?\n/);
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("versioned source release contract", () => {
  it("archives the exact tracked snapshot beneath one top-level directory", () => {
    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", sha], { encoding: "utf-8" })
      .trim()
      .split(/\r?\n/);
    const archived = entries
      .filter((entry) => !entry.endsWith("/"))
      .map((entry) => entry.slice(`${prefix}/`.length));

    expect(entries.every((entry) => entry.startsWith(`${prefix}/`))).toBe(true);
    expect(archived).toEqual(tracked);
  });

  it("contains the source, install hooks, local packages, and runtime assets", () => {
    const required = [
      "package.json",
      "package-lock.json",
      "src/index.ts",
      "scripts/build-ari.js",
      "scripts/prebuild-dist.mjs",
      "packages/arikernel/core/package.json",
      "config/tools.json",
      "public/app.html",
    ];

    for (const path of required) {
      expect(entries).toContain(`${prefix}/${path}`);
    }
  });

  it("publishes install commands that match a source distribution", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf-8");

    expect(workflow).toContain(
      'node scripts/build-source-archive.mjs "$RELEASE_TAG" "local-agent-x-${VERSION}.tar.gz" "local-agent-x-${VERSION}"',
    );
    expect(workflow).toContain("cd local-agent-x-${{ env.VERSION }}");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run dev");
    expect(workflow).not.toContain("npm install --production");
    expect(workflow).not.toContain("tar -czf local-agent-x-");
  });
});
