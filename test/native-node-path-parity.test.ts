import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The desktop runtime (buildAugmentedPath) and the installer (runtimeNodeEnv)
// each prepend the same dir list to PATH so they resolve the SAME `node`. If
// they drift, the installer builds native addons (better-sqlite3) against one
// Node major while the runtime spawns another → NODE_MODULE_VERSION crash on
// first boot → repair-screen loop. This test fails loudly the moment one list
// is edited without the other.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function augmentsInBlock(file: string, arrayName: string): string[] {
  const src = readFileSync(join(repoRoot, file), "utf-8");
  const start = src.indexOf(arrayName);
  expect(start, `${arrayName} not found in ${file}`).toBeGreaterThan(-1);
  const open = src.indexOf("[", start);
  const close = src.indexOf("]", open);
  expect(close, `unterminated array for ${arrayName} in ${file}`).toBeGreaterThan(open);
  const body = src.slice(open + 1, close);
  return [...body.matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

describe("native node-path resolution parity", () => {
  it("installer and runtime prepend identical PATH augments", () => {
    const runtime = augmentsInBlock("desktop/src/server-process.ts", "PATH_AUGMENTS = [");
    const installer = augmentsInBlock("scripts/install-common.mjs", "RUNTIME_NODE_PATH_AUGMENTS = [");
    expect(runtime.length).toBeGreaterThan(0);
    expect(installer).toEqual(runtime);
  });
});
