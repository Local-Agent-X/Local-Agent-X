// SV-4 invariants: the conflict resolver must NEVER git-add a JSON brain file
// with literal conflict markers inside (one marker in tasks.json makes every
// machine JSON.parse-throw on pull → that file silently stops syncing), and
// must not mangle narrative .md files outside the conflicted hunks (the old
// whole-file trim + Set-dedup shredded prose).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mergeJsonSides, resolveConflicts, unionMergeConflictHunks, type GitFn } from "./conflict-resolver.js";

const marked = (ours: string, theirs: string) =>
  `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> origin/main\n`;

function fakeGit(status: string, stages: Record<string, string>, calls: string[][]): GitFn {
  return async (...args: string[]) => {
    calls.push(args);
    if (args[0] === "status") return status;
    if (args[0] === "show") {
      const body = stages[args[1]];
      if (body === undefined) throw new Error(`no stage ${args[1]}`);
      return body.trim(); // AgentSync's git() trims stdout — mirror that
    }
    return "";
  };
}

describe("resolveConflicts", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("resolves a conflicted tasks.json to valid, union-merged JSON (no markers)", async () => {
    dir = mkdtempSync(join(tmpdir(), "lax-conflict-"));
    const ours = JSON.stringify([
      { id: "a", title: "local edit", updated_at: 200 },
      { id: "b", title: "local only", updated_at: 50 },
    ]);
    const theirs = JSON.stringify([
      { id: "a", title: "stale remote", updated_at: 100 },
      { id: "c", title: "remote only", updated_at: 60 },
    ]);
    // Working copy as git leaves it mid-merge: marker-laced.
    writeFileSync(join(dir, "tasks.json"), marked(ours + "\n", theirs + "\n"));
    const calls: string[][] = [];
    const git = fakeGit("UU tasks.json", { ":2:tasks.json": ours, ":3:tasks.json": theirs }, calls);

    await resolveConflicts(dir, git);

    const written = readFileSync(join(dir, "tasks.json"), "utf-8");
    expect(written).not.toContain("<<<<<<<");
    const parsed = JSON.parse(written) as { id: string; title: string }[]; // pre-fix: throws on markers
    const byId = new Map(parsed.map((t) => [t.id, t]));
    expect(byId.get("a")?.title).toBe("local edit"); // newer updated_at wins
    expect(byId.get("b")?.title).toBe("local only");
    expect(byId.get("c")?.title).toBe("remote only");
    expect(calls).toContainEqual(["add", "tasks.json"]);
    expect(calls.some((c) => c[0] === "commit")).toBe(true);
  });

  it("unions a conflicted facts.jsonl line-wise, every line still parseable", async () => {
    dir = mkdtempSync(join(tmpdir(), "lax-conflict-"));
    const shared = `{"kind":"fact","content":"shared"}`;
    const local = `{"kind":"fact","content":"from-local"}`;
    const remote = `{"kind":"fact","content":"from-remote"}`;
    writeFileSync(join(dir, "facts.jsonl"), `${shared}\n${marked(local + "\n", remote + "\n")}`);
    const git = fakeGit("UU facts.jsonl", {}, []);

    await resolveConflicts(dir, git);

    const out = readFileSync(join(dir, "facts.jsonl"), "utf-8");
    expect(out).not.toContain("<<<<<<<");
    const rows = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { content: string });
    expect(rows.map((r) => r.content)).toEqual(["shared", "from-local", "from-remote"]);
  });

  it("preserves .md prose outside conflict hunks byte-for-byte", async () => {
    dir = mkdtempSync(join(tmpdir(), "lax-conflict-"));
    // Narrative traits the old Set-dedup destroyed: blank lines, indentation,
    // and a legitimately repeated line.
    const prose = "# Notes\n\n  indented detail\n\nrepeat me\n\nrepeat me\n";
    writeFileSync(join(dir, "notes.md"), prose + marked("local line\n", "remote line\n"));
    const git = fakeGit("UU notes.md", {}, []);

    await resolveConflicts(dir, git);

    const out = readFileSync(join(dir, "notes.md"), "utf-8");
    expect(out.startsWith(prose)).toBe(true); // pre-fix: trimmed + deduped + blanks stripped
    expect(out).toContain("local line");
    expect(out).toContain("remote line");
    expect(out).not.toContain("=======");
  });
});

describe("mergeJsonSides", () => {
  it("keeps the side that parses when the other is corrupt", () => {
    const good = JSON.stringify([{ id: "x", updatedAt: 1 }]);
    expect(JSON.parse(mergeJsonSides("{ not json", good)!)).toEqual([{ id: "x", updatedAt: 1 }]);
    expect(JSON.parse(mergeJsonSides(good, "{ not json")!)).toEqual([{ id: "x", updatedAt: 1 }]);
    expect(mergeJsonSides("{ nope", "{ nope")).toBeNull();
  });

  it("keeps the local side for non-array JSON (config objects)", () => {
    const merged = mergeJsonSides(`{"servers":{"a":1}}`, `{"servers":{"b":2}}`);
    expect(JSON.parse(merged!)).toEqual({ servers: { a: 1 } });
  });

  it("dedups id-less records by content", () => {
    const merged = mergeJsonSides(`[{"v":1},{"v":2}]`, `[{"v":2},{"v":3}]`);
    expect(JSON.parse(merged!)).toHaveLength(3);
  });
});

describe("unionMergeConflictHunks", () => {
  it("drops the diff3 base section", () => {
    const content = `keep\n<<<<<<< HEAD\nours\n||||||| base\nold base\n=======\ntheirs\n>>>>>>> origin/main\ntail\n`;
    expect(unionMergeConflictHunks(content)).toBe("keep\nours\ntheirs\ntail\n");
  });

  it("leaves marker-free content untouched", () => {
    const content = "a\n\na\n  b\n";
    expect(unionMergeConflictHunks(content)).toBe(content);
  });
});
