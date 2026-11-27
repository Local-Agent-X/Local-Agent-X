// A session's tools, in its own order and kept on disk (session-tool-memory.ts):
// a new turn starts with exactly the list the last one ended with, restart or
// not, so the provider's cached prompt prefix still matches (Grok's chat,
// 2026-11-27: ~260k of one turn's ~330k uncached prompt tokens came from the
// list changing).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-session-tools-"));

const memory = await import("./session-tool-memory.js");

/** What a restart does to the server's memory: drops it. The saved copy stays. */
async function restart(): Promise<typeof memory> {
  const { vi } = await import("vitest");
  vi.resetModules();
  return import("./session-tool-memory.js");
}

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("a session's tools", () => {
  beforeEach(() => memory._resetSessionToolsForTests());

  it("keep the order the session first sent them, a mid-turn load last", () => {
    memory.rememberSessionTools("s1", ["read", "bash", "grep"]);
    memory.rememberSessionTools("s1", ["start_app_build"]); // loaded mid-turn: appended
    memory.rememberSessionTools("s1", ["bash", "read"]); // already known: no change
    expect([...memory.sessionToolsOf("s1")!]).toEqual(["read", "bash", "grep", "start_app_build"]);
  });

  it("the next turn's list, picked in any order, comes out as the last turn ended", () => {
    memory.rememberSessionTools("s1", ["read", "bash", "grep", "start_app_build"]);
    const picked = named("bash", "grep", "read", "start_app_build"); // catalog order
    expect(memory.inSessionOrder("s1", picked).map((t) => t.name)).toEqual(["read", "bash", "grep", "start_app_build"]);
    // A tool the session has not sent yet goes after, in the order given.
    expect(memory.inSessionOrder("s1", [...picked, ...named("web_search", "edit")]).map((t) => t.name))
      .toEqual(["read", "bash", "grep", "start_app_build", "web_search", "edit"]);
  });

  it("survive a restart", async () => {
    memory.rememberSessionTools("chat-mwzepzxs-sv6zs", ["read", "bash", "build_decide"]);
    const after = await restart();
    expect([...after.sessionToolsOf("chat-mwzepzxs-sv6zs")!]).toEqual(["read", "bash", "build_decide"]);
  });

  it("are kept in memory only for an id that is not a safe file name", async () => {
    memory.rememberSessionTools("../escape", ["read"]);
    expect([...memory.sessionToolsOf("../escape")!]).toEqual(["read"]);
    const after = await restart();
    expect(after.sessionToolsOf("../escape")).toBeUndefined();
  });
});
