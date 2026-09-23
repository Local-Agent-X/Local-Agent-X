// The prune that enforces SKIP_DIRS against the mirror is only worth anything
// if push actually reaches it. Its first wiring sat inside
// `if (config.syncWorkspace)` and `if (existsSync(workspace))` — so a machine
// syncing protocols only, or one whose workspace folder had moved, kept
// re-hashing an excluded tree on every push forever. This pins the reach, not
// the walk (mirror.test.ts covers the walk).
//
// Only the protocols-only path is exercised: the syncWorkspace branch resolves
// the real workspaceRoot() and would copy the user's entire workspace into a
// temp dir. Reaching the prune with workspace sync OFF is the stronger case
// anyway — it is the branch the first wiring missed.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyToSync } from "./push-files.js";
import { DEFAULT_CONFIG, type SyncConfig } from "./constants.js";

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

/** A sync dir whose mirror already holds a tree that SKIP_DIRS now excludes. */
function withMirroredJunk(): { dataDir: string; syncDir: string; junk: string } {
  root = mkdtempSync(join(tmpdir(), "lax-push-"));
  const dataDir = join(root, "data");
  const syncDir = join(root, "sync");
  const junk = join(syncDir, "workspace", "voice", "venv", "Lib", "site-packages");
  mkdirSync(join(junk, "torch"), { recursive: true });
  writeFileSync(join(junk, "torch", "nn.py"), "x");
  mkdirSync(dataDir, { recursive: true });
  return { dataDir, syncDir, junk };
}

const config = (over: Partial<SyncConfig>): SyncConfig => ({ ...DEFAULT_CONFIG, ...over });

describe("copyToSync reaches the mirror prune", () => {
  it("prunes when workspace sync is off and only protocols flow", async () => {
    const { dataDir, syncDir, junk } = withMirroredJunk();
    await copyToSync(dataDir, syncDir, config({ syncWorkspace: false, syncProtocols: true }));
    expect(existsSync(junk)).toBe(false);
  });
});
