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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyToSync } from "./push-files.js";
import { engineCheckoutMarker } from "./mirror.js";
import { DEFAULT_CONFIG, type SyncConfig } from "./constants.js";
import { readSyncedNotes, recordSyncedNotes } from "./synced-notes.js";
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

describe("copyToSync and memory notes", () => {
  function dirs(): { dataDir: string; syncDir: string } {
    root = mkdtempSync(join(tmpdir(), "lax-push-notes-"));
    const dataDir = join(root, "data"); const syncDir = join(root, "sync");
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    mkdirSync(join(syncDir, "memory"), { recursive: true });
    return { dataDir, syncDir };
  }
  const off = config({ syncWorkspace: false, syncProtocols: false, syncSessions: false });

  it("removes from the repo a note deleted here, and keeps one another machine added", async () => {
    const { dataDir, syncDir } = dirs();
    writeFileSync(join(dataDir, "memory", "kept.md"), "kept");
    recordSyncedNotes(dataDir, ["kept.md", "deleted-here.md"]);
    writeFileSync(join(syncDir, "memory", "deleted-here.md"), "old");
    // Arrived with this push's own git pull; never pulled into memory/ here.
    writeFileSync(join(syncDir, "memory", "from-other-machine.md"), "new");

    await copyToSync(dataDir, syncDir, off);

    expect(existsSync(join(syncDir, "memory", "deleted-here.md"))).toBe(false);
    expect(existsSync(join(syncDir, "memory", "from-other-machine.md"))).toBe(true);
    expect([...(readSyncedNotes(dataDir) ?? [])]).toEqual(["kept.md"]);
  });
});

// 2026-11-13: two machines held the same 2,300 chats with different ids on the
// same rows (the one-time time repair ran on each copy). Each push wrote its
// own copy over the other's, so the mirror flipped every time sync passed
// between them, about 7 MB a turn.
describe("copyToSync writes a session log only when this machine changed it", () => {
  const meta = (id: string, updatedAt: number) => JSON.stringify({ kind: "meta", id, title: "t", createdAt: 1, updatedAt });
  const msg = (rowId: string, content: string) => JSON.stringify({ kind: "msg", message: { role: "user", content }, id: rowId, createdAt: "2026-07-21T23:19:36.089Z" });
  const log = (rowIds: string[], updatedAt = 5) => [meta("s1", updatedAt), ...rowIds.map((r, i) => msg(r, `said ${i}`))].join("\n") + "\n";
  const sessionsOnly = config({ syncWorkspace: false, syncProtocols: false, syncSessions: true });

  function dirs(): { src: string; dest: string; dataDir: string; syncDir: string } {
    root = mkdtempSync(join(tmpdir(), "lax-push-sessions-own-"));
    const dataDir = join(root, "data"); const syncDir = join(root, "sync");
    mkdirSync(join(dataDir, "sessions"), { recursive: true }); mkdirSync(join(syncDir, "sessions"), { recursive: true });
    return { dataDir, syncDir, src: join(dataDir, "sessions", "s1.jsonl"), dest: join(syncDir, "sessions", "s1.jsonl") };
  }

  it("leaves the other machine's copy when this one is not ahead of it", async () => {
    const { dataDir, syncDir, src, dest } = dirs();
    writeFileSync(src, log(["um-1", "cm-2"]));
    const theirs = log(["sm-aaaa", "sm-bbbb"]);
    writeFileSync(dest, theirs);
    await copyToSync(dataDir, syncDir, sessionsOnly);
    expect(readFileSync(dest, "utf-8")).toBe(theirs);
    // The other machine pushes again; nothing changed here, so it stays.
    const again = log(["sm-cccc", "sm-dddd"]);
    writeFileSync(dest, again);
    await copyToSync(dataDir, syncDir, sessionsOnly);
    expect(readFileSync(dest, "utf-8")).toBe(again);
  });

  it("writes it once this machine adds to the chat, and a log the mirror lacks", async () => {
    const { dataDir, syncDir, src, dest } = dirs();
    writeFileSync(src, log(["um-1"]));
    utimesSync(src, new Date(), new Date(Date.now() - 60_000));
    writeFileSync(dest, log(["sm-aaaa"]));
    await copyToSync(dataDir, syncDir, sessionsOnly);
    writeFileSync(src, log(["um-1", "um-2"], 9));
    await copyToSync(dataDir, syncDir, sessionsOnly);
    expect(readFileSync(dest, "utf-8")).toBe(log(["um-1", "um-2"], 9));

    writeFileSync(join(dataDir, "sessions", "s2.jsonl"), log(["um-9"]));
    await copyToSync(dataDir, syncDir, sessionsOnly);
    expect(existsSync(join(syncDir, "sessions", "s2.jsonl"))).toBe(true);
  });

  it("writes a local copy that is ahead even with no record of a last push", async () => {
    const { dataDir, syncDir, src, dest } = dirs();
    writeFileSync(src, log(["um-1", "um-2"]));
    writeFileSync(dest, log(["sm-aaaa"]));
    await copyToSync(dataDir, syncDir, sessionsOnly);
    expect(readFileSync(dest, "utf-8")).toBe(log(["um-1", "um-2"]));
  });
});

describe("copyToSync ships sessions, never the list cache", () => {
  it("copies session logs and skips the .metadata dotfiles", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-push-sessions-"));
    const dataDir = join(root, "data"); const syncDir = join(root, "sync");
    mkdirSync(join(dataDir, "sessions"), { recursive: true }); mkdirSync(syncDir, { recursive: true });
    writeFileSync(join(dataDir, "sessions", "s1.jsonl"), '{"kind":"meta","id":"s1"}\n');
    writeFileSync(join(dataDir, "sessions", ".metadata.json"), "{}");
    writeFileSync(join(dataDir, "sessions", ".metadata.jsonl"), "");
    await copyToSync(dataDir, syncDir, config({ syncWorkspace: false, syncProtocols: false, syncSessions: true }));
    expect(existsSync(join(syncDir, "sessions", "s1.jsonl"))).toBe(true);
    expect(existsSync(join(syncDir, "sessions", ".metadata.json"))).toBe(false);
    expect(existsSync(join(syncDir, "sessions", ".metadata.jsonl"))).toBe(false);
  });
});
