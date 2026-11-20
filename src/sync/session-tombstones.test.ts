// A chat erased on one machine stays erased everywhere sync reaches
// (session-tombstones.ts): pull never copies it back, push leaves it out of
// the mirror, and another machine learns which of its copies to erase. A
// messaging chat that keeps its id after the erase still syncs its new log.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { erasedLocalSessionIds, tombstoneErasedSession } from "./session-tombstones.js";
import { pullSessions } from "./pull-files/pull-misc.js";
import { pushSessions } from "./push-sessions.js";
import { DEFAULT_CONFIG } from "./constants.js";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function dirs() {
  root = mkdtempSync(join(tmpdir(), "lax-session-tombstones-"));
  const dataDir = join(root, "data");
  const syncDir = join(root, "sync");
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  mkdirSync(join(syncDir, "sessions"), { recursive: true });
  return { dataDir, syncDir };
}

const logOf = (id: string, createdAt: number) =>
  `{"kind":"meta","id":"${id}","title":"t","createdAt":${createdAt},"updatedAt":${createdAt}}\n{"kind":"msg","message":{"role":"user","content":"hi"}}\n`;
const config = { ...DEFAULT_CONFIG, syncSessions: true };

describe("an erased chat across sync", () => {
  it("erasing drops the mirror's copy and pull never brings it back", () => {
    const { dataDir, syncDir } = dirs();
    writeFileSync(join(syncDir, "sessions", "s1.jsonl"), logOf("s1", 100));
    tombstoneErasedSession(syncDir, "s1", 200);
    expect(existsSync(join(syncDir, "sessions", "s1.jsonl"))).toBe(false);

    // Another machine that has not pulled the tombstone yet pushes its copy back.
    writeFileSync(join(syncDir, "sessions", "s1.jsonl"), logOf("s1", 100));
    expect(pullSessions(dataDir, syncDir, config)).toEqual([]);
    expect(existsSync(join(dataDir, "sessions", "s1.jsonl"))).toBe(false);
  });

  it("a new chat under the same id, begun after the erase, still syncs", () => {
    const { dataDir, syncDir } = dirs();
    tombstoneErasedSession(syncDir, "wa-1", 200);
    writeFileSync(join(syncDir, "sessions", "wa-1.jsonl"), logOf("wa-1", 300));
    expect(pullSessions(dataDir, syncDir, config)).toEqual(["wa-1"]);
  });

  it("push leaves a copy of an erased chat out of the mirror", async () => {
    const { dataDir, syncDir } = dirs();
    writeFileSync(join(dataDir, "sessions", "s1.jsonl"), logOf("s1", 100));
    writeFileSync(join(dataDir, "sessions", "s2.jsonl"), logOf("s2", 100));
    tombstoneErasedSession(syncDir, "s1", 200);
    await pushSessions(dataDir, syncDir);
    expect(existsSync(join(syncDir, "sessions", "s1.jsonl"))).toBe(false);
    expect(existsSync(join(syncDir, "sessions", "s2.jsonl"))).toBe(true);
  });

  it("another machine learns which of its copies, live or archived, to erase", () => {
    const { dataDir, syncDir } = dirs();
    writeFileSync(join(dataDir, "sessions", "s1.jsonl"), logOf("s1", 100));
    mkdirSync(join(dataDir, "sessions-archive"));
    writeFileSync(join(dataDir, "sessions-archive", "s2.jsonl"), logOf("s2", 100));
    writeFileSync(join(dataDir, "sessions", "wa-1.jsonl"), logOf("wa-1", 300));
    writeFileSync(join(dataDir, "sessions", "s3.jsonl"), logOf("s3", 100));
    for (const id of ["s1", "s2", "wa-1"]) tombstoneErasedSession(syncDir, id, 200);
    expect(erasedLocalSessionIds(dataDir, syncDir).sort()).toEqual(["s1", "s2"]);
  });
});
