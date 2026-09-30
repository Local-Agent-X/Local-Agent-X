import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullSessions } from "./pull-misc.js";
import { DEFAULT_CONFIG, type SyncConfig } from "../constants.js";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function dirs(): { dataDir: string; syncDir: string; local: string; remote: string } {
  root = mkdtempSync(join(tmpdir(), "lax-pull-sessions-"));
  const dataDir = join(root, "data");
  const syncDir = join(root, "sync");
  const local = join(dataDir, "sessions");
  const remote = join(syncDir, "sessions");
  mkdirSync(local, { recursive: true });
  mkdirSync(remote, { recursive: true });
  return { dataDir, syncDir, local, remote };
}

const config: SyncConfig = { ...DEFAULT_CONFIG, syncSessions: true };
const SHORT = '{"kind":"meta","id":"s1"}\n{"kind":"msg","message":{"role":"user","content":"hi"}}\n';
const LONG = `${SHORT}{"kind":"msg","message":{"role":"assistant","content":"the fact you asked about"}}\n`;

describe("pullSessions", () => {
  it("copies a session this machine lacks and reports its id", () => {
    const { dataDir, syncDir, local, remote } = dirs();
    writeFileSync(join(remote, "s1.jsonl"), SHORT);
    expect(pullSessions(dataDir, syncDir, config)).toEqual(["s1"]);
    expect(readFileSync(join(local, "s1.jsonl"), "utf-8")).toBe(SHORT);
  });

  it("extends a session the other machine kept writing to, and leaves one that did not grow", () => {
    const { dataDir, syncDir, local, remote } = dirs();
    writeFileSync(join(local, "s1.jsonl"), SHORT);
    writeFileSync(join(remote, "s1.jsonl"), LONG);
    writeFileSync(join(local, "s2.jsonl"), LONG);
    writeFileSync(join(remote, "s2.jsonl"), SHORT);
    expect(pullSessions(dataDir, syncDir, config)).toEqual(["s1"]);
    expect(readFileSync(join(local, "s1.jsonl"), "utf-8")).toBe(LONG);
    expect(readFileSync(join(local, "s2.jsonl"), "utf-8")).toBe(LONG);
  });

  it("never pulls the list-cache dotfiles or a session this machine archived", () => {
    const { dataDir, syncDir, local, remote } = dirs();
    writeFileSync(join(remote, ".metadata.json"), "{}");
    writeFileSync(join(remote, ".metadata.jsonl"), "");
    writeFileSync(join(remote, "old.jsonl"), LONG);
    mkdirSync(join(dataDir, "sessions-archive"));
    writeFileSync(join(dataDir, "sessions-archive", "old.jsonl"), SHORT);
    expect(pullSessions(dataDir, syncDir, config)).toEqual([]);
    expect(existsSync(join(local, ".metadata.json"))).toBe(false);
    expect(existsSync(join(local, "old.jsonl"))).toBe(false);
  });

  it("does nothing when session sync is off", () => {
    const { dataDir, syncDir, remote } = dirs();
    writeFileSync(join(remote, "s1.jsonl"), SHORT);
    expect(pullSessions(dataDir, syncDir, { ...config, syncSessions: false })).toEqual([]);
  });
});
