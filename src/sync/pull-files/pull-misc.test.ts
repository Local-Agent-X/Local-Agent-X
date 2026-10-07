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

// Which copy of a session is later is decided by the conversation, not bytes:
// one author per chat, so more message rows is later, and a tie goes to the
// later updatedAt. Rows grew an id and a time marker (2026-10-07); on bytes a
// copy could win while missing a message.
describe("pullSessions — the copy holding more of the conversation wins", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const cfg = { ...DEFAULT_CONFIG, syncSessions: true } as SyncConfig;
  const log = (updatedAt: number, msgs: string[], pad = "") =>
    [JSON.stringify({ kind: "meta", id: "chat-s", title: "s", createdAt: 1, updatedAt }),
      ...msgs.map((c, i) => JSON.stringify({ kind: "msg", id: `m${i}${pad}`, message: { role: "user", content: c }, createdAt: "2026-10-07T00:00:00Z" }))].join("\n") + "\n";
  function setup(local: string, remote: string) {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "lax-pull-sess-"));
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    mkdirSync(join(root, "sync", "sessions"), { recursive: true });
    writeFileSync(join(root, "data", "sessions", "chat-s.jsonl"), local);
    writeFileSync(join(root, "sync", "sessions", "chat-s.jsonl"), remote);
    return pullSessions(join(root, "data"), join(root, "sync"), cfg);
  }

  it("keeps a local copy with one more message even when the mirror's copy is bigger in bytes", () => {
    const local = log(2, ["a", "b", "c"]);
    const remote = log(1, ["a", "b"], "x".repeat(400));
    expect(remote.length).toBeGreaterThan(local.length);
    expect(setup(local, remote)).toEqual([]);
    expect(readFileSync(join(root, "data", "sessions", "chat-s.jsonl"), "utf8")).toBe(local);
  });

  it("takes the mirror's copy when it has more messages, even when smaller", () => {
    const local = log(1, ["a"], "x".repeat(400));
    const remote = log(2, ["a", "b"]);
    expect(setup(local, remote)).toEqual(["chat-s"]);
    expect(readFileSync(join(root, "data", "sessions", "chat-s.jsonl"), "utf8")).toBe(remote);
  });

  it("on equal message counts, the later updatedAt wins", () => {
    expect(setup(log(5, ["a"]), log(9, ["a"]))).toEqual(["chat-s"]);
    expect(setup(log(9, ["a"]), log(5, ["a"]))).toEqual([]);
  });
});
