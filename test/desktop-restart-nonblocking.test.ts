/**
 * Server-(re)start path must never block the Electron main thread.
 *
 * Root cause of the intermittent ~15s whole-app freeze while typing: OTA
 * rolling updates and crash-recovery restart the server child mid-session,
 * and the restart path ran three synchronous blocks on the main process —
 * a statSync sweep of every src/*.ts (~1200 Defender-intercepted stats), an
 * execSync("node -v"), and an execSync taskkill. All windows froze for the
 * whole sequence.
 *
 * Locks the fix in two layers:
 *   1. behavior — the async freshness sweep still answers correctly
 *   2. source contract — the sync APIs must not reappear on this path
 *      (stopServerSync is the one deliberate exception: will-quit cannot
 *      await, and a frozen app during quit is invisible)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serverDistIsFresh } from "../desktop/src/dist-freshness";

const DESKTOP_SRC = fileURLToPath(new URL("../desktop/src", import.meta.url));

let root: string;

// mtimes are set explicitly — filesystem timestamp granularity would make
// write-order flaky.
const touch = (path: string, epochS: number) => utimesSync(path, epochS, epochS);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dist-fresh-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "src", "nested", "b.ts"), "");
  writeFileSync(join(root, "dist", "index.js"), "");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("serverDistIsFresh (async sweep)", () => {
  it("returns true when dist is newer than every source file", async () => {
    touch(join(root, "src", "a.ts"), 1_000);
    touch(join(root, "src", "nested", "b.ts"), 1_000);
    touch(join(root, "dist", "index.js"), 2_000);
    await expect(serverDistIsFresh(root)).resolves.toBe(true);
  });

  it("returns false when any source file (even nested) is newer than dist", async () => {
    touch(join(root, "src", "a.ts"), 1_000);
    touch(join(root, "dist", "index.js"), 2_000);
    touch(join(root, "src", "nested", "b.ts"), 3_000);
    await expect(serverDistIsFresh(root)).resolves.toBe(false);
  });

  it("returns false when dist/index.js is missing", async () => {
    rmSync(join(root, "dist", "index.js"));
    await expect(serverDistIsFresh(root)).resolves.toBe(false);
  });
});

describe("source contract — no sync blocks on the restart path", () => {
  const read = (f: string) => readFileSync(join(DESKTOP_SRC, f), "utf-8");

  it("dist-freshness.ts sweeps with fs/promises, not statSync/readdirSync", () => {
    const src = read("dist-freshness.ts");
    expect(src).not.toMatch(/\bstatSync\b/);
    expect(src).not.toMatch(/\breaddirSync\b/);
  });

  it("node-floor.ts resolves node -v without execSync", () => {
    expect(read("node-floor.ts")).not.toMatch(/\bexecSync\s*\(/);
    expect(read("node-floor.ts")).not.toMatch(/import\s*\{[^}]*\bexecSync\b/);
  });

  it("server-process.ts confines execSync to stopServerSync (the will-quit path)", () => {
    const src = read("server-process.ts");
    const stopSyncStart = src.indexOf("export function stopServerSync");
    expect(stopSyncStart).toBeGreaterThan(-1);
    const beforeStopSync = src.slice(0, stopSyncStart);
    // No execSync CALLS anywhere before stopServerSync — the import specifier
    // itself doesn't count, so strip import lines first.
    const callsBefore = beforeStopSync
      .split("\n")
      .filter(l => !/^\s*import\b|^import\b/.test(l) && /\bexecSync\s*\(/.test(l));
    expect(callsBefore).toEqual([]);
  });

  it("startServer awaits the freshness and node-floor checks (stays async)", () => {
    const src = read("server-process.ts");
    expect(src).toMatch(/await serverDistIsFresh\(/);
    expect(src).toMatch(/await checkNodeFloor\(/);
    expect(src).toMatch(/export async function startServer\(/);
  });
});
