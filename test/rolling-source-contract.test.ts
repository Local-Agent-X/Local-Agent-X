import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildRollingSource, buildRollingPointer, ROLLING_POINTER_ASSET } from "../scripts/build-rolling-source.mjs";
// The REAL verifier the in-app updater runs. Importing it (not a copy) is the
// whole point: this test proves the PUBLISH side (build-rolling-source) emits
// exactly what the VERIFY side (ota-update) accepts — the cross-seam contract
// that was the open gap. If either side drifts, this fails.
import { assertSha256 } from "../src/ota-update.js";
import { parseRollingPointer, ROLLING_POINTER_ASSET as CLIENT_POINTER_ASSET } from "../src/ota-rolling-pointer.js";
import { resolveTarBinaries } from "../src/ota-extract.js";

// `git archive` needs a real commit; HEAD always exists in the repo under test.
const sha = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();

let outDir: string;
let built: ReturnType<typeof buildRollingSource>;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "rolling-source-"));
  const desktopDist = join(outDir, "desktop-dist");
  mkdirSync(desktopDist, { recursive: true });
  writeFileSync(join(desktopDist, "main.js"), "// compiled desktop fixture\n");
  built = buildRollingSource(sha, outDir, { desktopDistDir: desktopDist, requireDesktopDist: true });
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("rolling-source publish ⟷ verify contract", () => {
  it("names the asset exactly as the app resolves it (lax-source-<full-sha>.tar.gz)", () => {
    // The app builds this name from the GitHub commits API `sha` (full 40 chars)
    // — any divergence and the verified path silently never matches.
    expect(built.assetName).toBe(`lax-source-${sha}.tar.gz`);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("the published sidecar passes the real assertSha256 over the published bytes", () => {
    const buf = readFileSync(built.assetPath);
    const sidecar = readFileSync(built.sidecarPath, "utf-8");
    // Must not throw — this is the exact call ota-update.downloadMainTarball makes.
    expect(() => assertSha256(buf, sidecar)).not.toThrow();
  });

  it("writes the sidecar in sha256sum format (hash + two spaces + filename)", () => {
    const sidecar = readFileSync(built.sidecarPath, "utf-8");
    expect(sidecar).toBe(`${built.hash}  ${built.assetName}\n`);
    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("assertSha256 REJECTS a tampered asset (the guard actually bites)", () => {
    const buf = readFileSync(built.assetPath);
    const tampered = Buffer.from(buf);
    tampered[tampered.length - 1] ^= 0xff; // flip the last byte
    const sidecar = readFileSync(built.sidecarPath, "utf-8");
    expect(() => assertSha256(tampered, sidecar)).toThrow(/checksum mismatch/);
  });

  it("packs one top-level prefix so applyUpdate's --strip-components=1 lands the source root, with the desktop overlay, no node_modules and no links", () => {
    // The extractor half (applyUpdate -> extractTarball) is proven in src/ota-update.test.ts against single-prefix tarballs.
    const prefix = `lax-source-${sha}`;
    // Relative archive name: GNU tar reads the colon in an absolute Windows
    // path as a remote rsh host.
    const tar = (mode: string, ...members: string[]) =>
      execFileSync(resolveTarBinaries()[0], [mode, built.assetName, ...members], {
        cwd: outDir,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });

    const entries = tar("tzf").trim().split(/\r?\n/);
    expect(entries.every((entry) => entry.startsWith(`${prefix}/`))).toBe(true);
    expect(entries).toContain(`${prefix}/package.json`);
    expect(entries).toContain(`${prefix}/desktop/dist/main.js`);
    expect(entries.some((entry) => entry.startsWith(`${prefix}/node_modules/`))).toBe(false);

    expect(tar("xzOf", `${prefix}/desktop/dist/main.js`)).toBe("// compiled desktop fixture\n");

    // A non-admin Windows user's bsdtar cannot create links, so one entry would
    // break the update there. bsdtar and GNU tar both print a symlink's mode
    // as "l…" and a hard link's as "h…".
    const links = tar("tvzf").split(/\r?\n/).filter((line) => /^[lh]/.test(line));
    expect(links).toEqual([]);
  });

  it("refuses a short / malformed sha (won't publish an asset the app can't address)", () => {
    expect(() => buildRollingSource(sha.slice(0, 12), outDir)).toThrow(/40-char commit sha/);
  });

  it("refuses publication when the required desktop build is absent", () => {
    expect(() => buildRollingSource(sha, outDir, {
      desktopDistDir: join(outDir, "missing-desktop-dist"),
      requireDesktopDist: true,
    })).toThrow(/required desktop build is missing/);
  });

  it("the publisher compiles desktop before requiring it in the update asset", () => {
    const workflow = readFileSync(resolve(".github/workflows/rolling-source.yml"), "utf-8");
    const installRoot = workflow.indexOf("Install dependencies");
    const compile = workflow.indexOf("npx tsc --noEmitOnError");
    const packageAsset = workflow.indexOf("--require-desktop-dist");
    expect(installRoot).toBeGreaterThan(-1);
    expect(compile).toBeGreaterThan(installRoot);
    expect(packageAsset).toBeGreaterThan(compile);
  });
});

describe("rolling-pointer publish ⟷ verify contract", () => {
  // The pointer is what makes "only CI-proven commits reach users" true. If the
  // publisher and the client disagree on its NAME or SHAPE, the client 404s and
  // every install silently stops updating — so both sides are asserted here
  // against the real modules, not copies.
  it("publisher and client agree on the asset name", () => {
    expect(ROLLING_POINTER_ASSET).toBe(CLIENT_POINTER_ASSET);
  });

  it("the published pointer parses with the real client parser", () => {
    const { pointerPath, pointer } = buildRollingPointer(sha, "feat(x): a subject line", outDir);
    const parsed = parseRollingPointer(readFileSync(pointerPath, "utf-8"));
    expect(parsed.commit).toBe(sha);
    expect(parsed.commit).toBe(pointer.commit);
    expect(parsed.subject).toBe("feat(x): a subject line");
  });

  it("keeps only the first line of a multi-line commit message", () => {
    const message = ["fix: headline", "", "body paragraph"].join("\n");
    const { pointerPath } = buildRollingPointer(sha, message, outDir);
    expect(parseRollingPointer(readFileSync(pointerPath, "utf-8")).subject).toBe("fix: headline");
  });

  it("refuses to publish a pointer to a short / malformed sha", () => {
    expect(() => buildRollingPointer(sha.slice(0, 12), "x", outDir)).toThrow(/40-char commit sha/);
  });
});

describe("rolling-source workflow — publish order is the safety property", () => {
  const workflow = readFileSync(resolve(".github/workflows/rolling-source.yml"), "utf-8");

  // Ordering IS the guarantee. Build proves the commit; the asset upload makes
  // it downloadable; only then may the pointer name it. Any other order can
  // publish a pointer to a commit that is unproven or unfetchable — which is
  // how a broken push reached every installed client at once.
  it("builds BEFORE it packages or publishes anything", () => {
    // Match the executed `run:` lines, not the prose above them — a header
    // comment mentioning the script is not a publish step.
    const build = workflow.indexOf("run: npm run build");
    const pack = workflow.indexOf("run: node scripts/build-rolling-source.mjs");
    expect(build).toBeGreaterThan(-1);
    expect(pack).toBeGreaterThan(build);
  });

  it("runs the same build command the updater gates candidates with", () => {
    // validateExtractedUpdate → gateBuildAtAsync → npm run build. If CI ran a
    // narrower command, a commit could pass here and still be rejected on
    // every client — the exact failure this workflow exists to prevent. Read
    // the gate's real argv so the two sides cannot drift silently.
    const gates = readFileSync(resolve("src/self-edit/sandbox-gates.ts"), "utf-8");
    const argv = gates.match(/gateBuildAtAsync[\s\S]{0,240}?runGateCommandAt\(\s*dir,\s*\[([^\]]*)\]/);
    expect(argv, "gateBuildAtAsync no longer calls runGateCommandAt with a literal argv").not.toBeNull();
    const command = `npm ${argv![1].split(",").map((s) => s.trim().replace(/["']/g, "")).join(" ")}`;
    expect(command).toBe("npm run build");
    expect(workflow).toContain(`run: ${command}`);
  });

  it("uploads the source asset BEFORE advancing the pointer", () => {
    const upload = workflow.indexOf("gh release upload rolling \"$asset\"");
    const advance = workflow.indexOf("Advance the verified pointer");
    expect(upload).toBeGreaterThan(-1);
    expect(advance).toBeGreaterThan(upload);
  });

  it("refuses to move the pointer to a non-descendant commit", () => {
    expect(workflow).toContain("git merge-base --is-ancestor");
  });

  it("checks out full history, without which the ancestor proof cannot run", () => {
    expect(workflow).toContain("fetch-depth: 0");
  });

  it("never prunes the asset the pointer currently names", () => {
    expect(workflow).toContain("it is the published pointer target");
  });
});
