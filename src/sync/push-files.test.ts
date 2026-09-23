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
import { engineCheckoutMarker } from "./mirror.js";
import { DEFAULT_CONFIG, type SyncConfig } from "./constants.js";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";

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

// A workspace root that IS a checkout of the engine (2026-07-22: one machine's
// agent workspace was used as a repo checkout; sync mirrored its src/ to every
// machine for two months). SKIP_DIRS keeps .git out; nothing kept the tree out.
describe("the workspace push refuses an engine checkout", () => {
  /** A workspace dir shaped like the July 22 one: .git beside the engine's package.json, plus the user's own file. */
  function checkoutWorkspace(name = "local-agent-x"): string {
    const ws = join(root, "workspace");
    mkdirSync(join(ws, ".git"), { recursive: true });
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
    writeFileSync(join(ws, "src", "index.ts"), "export {};");
    writeFileSync(join(ws, "notes.md"), "mine");
    return ws;
  }

  it("names the checkout only when .git sits beside the engine's package.json", () => {
    root = mkdtempSync(join(tmpdir(), "lax-push-"));
    const ws = checkoutWorkspace();
    expect(engineCheckoutMarker(ws)).toMatch(/git checkout of local-agent-x/);
    rmSync(join(ws, ".git"), { recursive: true, force: true });
    expect(engineCheckoutMarker(ws)).toBeNull();
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "my-own-app" }));
    expect(engineCheckoutMarker(ws)).toBeNull();
    writeFileSync(join(ws, "package.json"), "not json");
    expect(engineCheckoutMarker(ws)).toBeNull();
  });

  it("mirrors nothing from a workspace that is a checkout — not the engine tree, not the user's files beside it", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-push-"));
    const ws = checkoutWorkspace();
    const dataDir = join(root, "data"); mkdirSync(dataDir, { recursive: true });
    const syncDir = join(root, "sync"); mkdirSync(syncDir, { recursive: true });
    const original = getRuntimeConfig();
    setRuntimeConfig({ ...original, workspace: ws } as LAXConfig);
    try {
      await copyToSync(dataDir, syncDir, config({ syncWorkspace: true, syncProtocols: false }));
    } finally {
      setRuntimeConfig(original);
    }
    expect(existsSync(join(syncDir, "workspace", "src"))).toBe(false);
    expect(existsSync(join(syncDir, "workspace", "notes.md"))).toBe(false);
  });
});
