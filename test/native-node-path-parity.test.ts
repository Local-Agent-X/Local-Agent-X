import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RUNTIME_NODE_PATH_AUGMENTS } from "../scripts/installer/process-tools.mjs";
import { managedRuntimeDir } from "../src/desktop-contract/data-dir.js";

// The desktop runtime (buildAugmentedPath) and the installer (runtimeNodeEnv)
// each prepend the same dir list to PATH so they resolve the SAME `node`. If
// they drift, the installer builds native addons (better-sqlite3) against one
// Node major while the runtime spawns another → NODE_MODULE_VERSION crash on
// first boot → repair-screen loop. This test fails loudly the moment one list
// is edited without the other. The runtime's first entry is the contract's
// managed runtime dir (an install location, never relocated by LAX_DATA_DIR);
// the installer, a plain script, spells the same path out.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The desktop's PATH_AUGMENTS, resolved as the runtime resolves them. */
function runtimeAugments(): string[] {
  const src = readFileSync(join(repoRoot, "desktop/src/server-process.ts"), "utf-8");
  const start = src.indexOf("PATH_AUGMENTS = [");
  expect(start, "PATH_AUGMENTS not found in desktop/src/server-process.ts").toBeGreaterThan(-1);
  const body = src.slice(src.indexOf("[", start) + 1, src.indexOf("]", start));
  // Each entry is one of: join(managedRuntimeDir(), "<rel>"), join(homedir(), "<rel>"), "<abs>".
  const entries = [...body.matchAll(/join\(managedRuntimeDir\(\), "([^"]+)"\)|join\(homedir\(\), "([^"]+)"\)|"([^"]+)"/g)];
  expect(entries.length, "PATH_AUGMENTS has no entries").toBeGreaterThan(0);
  return entries.map(([, underRuntime, underHome, absolute]) =>
    underRuntime ? join(managedRuntimeDir(), underRuntime) : underHome ? join(homedir(), underHome) : absolute);
}

describe("native node-path resolution parity", () => {
  it("installer and runtime prepend identical PATH augments", () => {
    const runtime = runtimeAugments();
    expect(runtime.length).toBeGreaterThan(0);
    expect(RUNTIME_NODE_PATH_AUGMENTS).toEqual(runtime);
  });
});
