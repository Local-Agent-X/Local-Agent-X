// Runtime self-heal for a native-addon ABI mismatch.
//
// better-sqlite3 (and the other native addons) embed a NODE_MODULE_VERSION
// tied to the exact Node major they were compiled against. When the node the
// installer built them with differs from the node startServer() spawns
// (install-time node ≠ runtime node), the first `require` throws
// NODE_MODULE_VERSION and the server exits on boot — which, untreated, just
// dead-ends at the repair screen.
//
// This rebuilds the addon against the EXACT node the desktop spawns
// (buildAugmentedPath — the same resolution startServer uses), then lets the
// caller retry. It is the runtime counterpart of the install/upgrade rebuild
// in scripts/install-common.mjs ("Verifying native module ABI…"), bound to the
// runtime node instead of the installer's node so the two can't disagree.
import { spawn } from "child_process";
import { buildAugmentedPath } from "./server-process";
import { getProjectRoot } from "./config";

// The substring Node prints when a compiled addon's ABI doesn't match the
// running runtime. Detected in the server child's stderr to distinguish this
// (auto-healable) crash from a generic boot failure.
export const NATIVE_ABI_SIGNATURE = "NODE_MODULE_VERSION";

// Scoped to better-sqlite3 — the addon that imports first and crashes boot.
// A full `npm rebuild` would recompile every package's install scripts and
// balloon the rebuild from seconds to minutes. If a later boot trips on a
// different addon, that addon's name joins this list.
const REBUILD_TARGETS = ["better-sqlite3"];

export async function rebuildNativeModules(): Promise<{ ok: boolean; detail: string }> {
  const projectRoot = getProjectRoot();
  if (!projectRoot) {
    return { ok: false, detail: "Project root unresolved; cannot rebuild native modules." };
  }
  return new Promise((resolve) => {
    const child = spawn(
      "npm",
      ["rebuild", ...REBUILD_TARGETS, "--no-audit", "--no-fund", "--loglevel=error"],
      {
        cwd: projectRoot,
        env: { ...process.env, PATH: buildAugmentedPath() },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let tail = "";
    const capture = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-400); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("error", (e) => resolve({ ok: false, detail: `Could not run npm rebuild: ${e.message}` }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, detail: "Native modules rebuilt against the runtime Node." });
      else resolve({ ok: false, detail: `Native rebuild failed (exit ${code}): ${tail.trim() || "no output"}` });
    });
  });
}
