import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
      'node .release-tools/scripts/build-source-archive.mjs "$SOURCE_SHA" "local-agent-x-${VERSION}.tar.gz" "local-agent-x-${VERSION}"',
    );
    expect(workflow).toContain("cd local-agent-x-${{ needs.release-gate.outputs.version }}");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run dev");
    expect(workflow).not.toContain("npm install --production");
    expect(workflow).not.toContain("tar -czf local-agent-x-");
  });

  it("requires an ASCII version tag and uses it as the immutable release ref", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf-8");
    const validation = workflow.indexOf('if [[ ! "$RELEASE_TAG" =~ ^v[0-9][0-9A-Za-z._-]*$ ]]');
    const checkout = workflow.indexOf("- uses: actions/checkout@v6");

    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(checkout);
    expect(workflow).toContain("ref: refs/tags/${{ env.RELEASE_TAG }}");
    expect(workflow).toContain("tag_name: ${{ env.RELEASE_TAG }}");
    expect(workflow).not.toContain("ref: ${{ inputs.tag || github.ref_name }}");
    expect(workflow).not.toContain("tag_name: ${{ inputs.tag || github.ref_name }}");

    const versionTag = /^v[0-9][0-9A-Za-z._-]*$/;
    expect(versionTag.test("v1.2.3")).toBe(true);
    for (const ref of ["main", sha, "vbeta", "v\u0661.2.3", "v1 bad", "v1/other"]) {
      expect(versionTag.test(ref), ref).toBe(false);
    }
  });

  it("loads release tooling outside a historical target tag before packaging", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf-8");
    const targetCheckout = workflow.indexOf("ref: refs/tags/${{ env.RELEASE_TAG }}");
    const toolCheckout = workflow.indexOf("- name: Check out trusted release tooling");
    const toolRef = workflow.indexOf("ref: ${{ github.event.repository.default_branch }}", toolCheckout);
    const toolPath = workflow.indexOf("path: .release-tools", toolCheckout);
    const gate = workflow.indexOf("node .release-tools/scripts/release-gate.mjs", toolPath);
    const immutableToolingCheckout = workflow.indexOf("ref: ${{ needs.release-gate.outputs.tooling_sha }}", gate);
    const packageStep = workflow.indexOf("- name: Package release");

    expect(targetCheckout).toBeGreaterThan(-1);
    expect(toolCheckout).toBeGreaterThan(targetCheckout);
    expect(toolRef).toBeGreaterThan(toolCheckout);
    expect(toolPath).toBeGreaterThan(toolRef);
    expect(gate).toBeGreaterThan(toolPath);
    expect(immutableToolingCheckout).toBeGreaterThan(gate);
    expect(packageStep).toBeGreaterThan(immutableToolingCheckout);
  });

  it("archives an older source ref that does not contain the release helper", () => {
    const historical = join(outDir, "historical");
    const historicalAsset = join(outDir, "historical.tar.gz");
    const helper = resolve("scripts", "build-source-archive.mjs");
    mkdirSync(historical);
    writeFileSync(join(historical, "package.json"), '{"name":"historical-release"}\n');
    execFileSync("git", ["init", "--quiet"], { cwd: historical });
    execFileSync("git", ["add", "package.json"], { cwd: historical });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Release Contract",
        "-c",
        "user.email=release@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "historical",
      ],
      { cwd: historical },
    );

    execFileSync(process.execPath, [helper, "HEAD", historicalAsset, "historical-release"], { cwd: historical });
    const historicalEntries = execFileSync("tar", ["tzf", historicalAsset], { encoding: "utf-8" })
      .trim()
      .split(/\r?\n/);
    expect(historicalEntries).toContain("historical-release/package.json");
    expect(historicalEntries.some((entry) => entry.includes("build-source-archive.mjs"))).toBe(false);
  });
});
