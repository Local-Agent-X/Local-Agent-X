// A pull visits everything the mirror holds, whether or not anything changed,
// and the server pulls as it starts. Each of its loops over a tree gives the
// server a turn per entry: the workspace walk once held the event loop for
// 6.6 s of a start (24,694 entries, nothing to copy), and comparing the chats
// for about a second before it.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig } from "../../types.js";
import { DEFAULT_CONFIG, type SyncConfig } from "../constants.js";
import { pullDir } from "../mirror.js";
import { copyFromSync } from "./index.js";
import { pullSessions } from "./pull-misc.js";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const MANY = 60;
const config = (over: Partial<SyncConfig> = {}): SyncConfig => ({ ...DEFAULT_CONFIG, syncProtocols: false, syncSessions: false, ...over });

/** How many times the event loop came round while `job` ran. */
async function turnsDuring(job: Promise<unknown>): Promise<number> {
  let running = true;
  const settled = job.then(() => { running = false; }, () => { running = false; });
  let turns = 0;
  while (running) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    turns++;
  }
  await settled;
  await job;
  return turns;
}

function fill(dir: string, count: number, text: string): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `f${i}.md`), `${text} ${i}`);
}

describe("a pull gives the server a turn per entry it visits", () => {
  it("the tree walk, when every local copy is already current", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-pull-turns-"));
    fill(join(root, "mirror", "notes"), MANY, "theirs");
    fill(join(root, "local", "notes"), MANY, "mine");
    const before = statSync(join(root, "local", "notes", "f0.md")).mtimeMs;

    expect(await turnsDuring(pullDir(join(root, "mirror"), join(root, "local"), true))).toBeGreaterThanOrEqual(MANY);

    // Written after the mirror's, so left alone: the walk only looked.
    expect(readFileSync(join(root, "local", "notes", "f0.md"), "utf-8")).toBe("mine 0");
    expect(statSync(join(root, "local", "notes", "f0.md")).mtimeMs).toBe(before);
  });

  it("the chats, when no pair has changed since the last pull", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-pull-turns-"));
    const dataDir = join(root, "data");
    const syncDir = join(root, "sync");
    const chat = '{"kind":"meta","id":"s"}\n{"kind":"msg","message":{"role":"user","content":"hi"}}\n';
    for (const dir of [join(dataDir, "sessions"), join(syncDir, "sessions")]) {
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < MANY; i++) writeFileSync(join(dir, `s${i}.jsonl`), chat);
    }
    const sessions = config({ syncSessions: true });
    expect(await pullSessions(dataDir, syncDir, sessions)).toEqual([]);

    let pulled: string[] = ["unset"];
    const turns = await turnsDuring(pullSessions(dataDir, syncDir, sessions).then((ids) => { pulled = ids; }));
    expect(turns).toBeGreaterThanOrEqual(MANY);
    expect(pulled).toEqual([]);
  });

  it("a whole pull, through the brain folders and the workspace", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-pull-turns-"));
    const dataDir = join(root, "data");
    const syncDir = join(root, "sync");
    const ws = join(root, "ws");
    fill(join(syncDir, "agent-runs"), MANY, "run");
    fill(join(syncDir, "workspace", "apps", "kept"), MANY, "kept");
    fill(join(syncDir, "workspace", "apps", "gone"), MANY, "gone");
    // "gone" was deleted on another machine; the mirror still holds its files.
    mkdirSync(join(syncDir, ".tombstones"), { recursive: true });
    writeFileSync(join(syncDir, ".tombstones", "gone.json"), "{}");
    mkdirSync(join(ws, "apps"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const original = getRuntimeConfig();
    setRuntimeConfig({ ...original, workspace: ws } as LAXConfig);
    let turns = 0;
    try {
      turns = await turnsDuring(copyFromSync(dataDir, syncDir, config({ syncWorkspace: true })));
    } finally {
      setRuntimeConfig(original);
    }

    expect(turns).toBeGreaterThanOrEqual(MANY * 3);
    expect(readFileSync(join(dataDir, "agent-runs", `f${MANY - 1}.md`), "utf-8")).toBe(`run ${MANY - 1}`);
    expect(readFileSync(join(ws, "apps", "kept", `f${MANY - 1}.md`), "utf-8")).toBe(`kept ${MANY - 1}`);
    // The deletion is applied once the copy has finished, not while it runs.
    expect(existsSync(join(ws, "apps", "gone"))).toBe(false);
  });
});
