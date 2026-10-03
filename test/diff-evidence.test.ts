// The audit gates' git reads. The paths are files the op edited and the grep
// patterns come from its diff, so both must reach git as argv entries, never
// as shell text, while the command still goes through the shell cage.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The cage itself is modelled, as in caged-spawn.test.ts: what goes through
// its wrap is recorded, and the command then runs unwrapped, for real.
const cage = vi.hoisted(() => ({ wrapped: [] as Array<{ file: string; args: string[] }> }));
vi.mock("../src/sandbox/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sandbox/index.js")>()),
  awaitSandboxProof: async () => {},
  getSandboxMode: () => "host",
  wrapSpawnForSandbox: (file: string, args: string[]) => {
    cage.wrapped.push({ file, args });
    return { cmd: file, args };
  },
}));

import { collectDiffEvidence } from "../src/canonical-loop/turn-loop/diff-evidence.js";
import { defaultFindConsumers } from "../src/canonical-loop/turn-loop/regression-audit.js";

const repos: string[] = [];
afterEach(() => {
  cage.wrapped.length = 0;
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "lax-diff-evidence-"));
  repos.push(repo);
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  return repo;
}

describe("collectDiffEvidence", () => {
  it("diffs a file named with $( ) and backticks without running either, through the cage", async () => {
    const name = "a$(touch pwned-a)`touch pwned-b`.ts";
    const repo = repoWith({ [name]: "export const v = 1;\n" });
    const edited = join(repo, name);
    writeFileSync(edited, "export const v = 2;\n");

    const evidence = await collectDiffEvidence([edited], 10_000);

    expect(existsSync(join(repo, "pwned-a")) || existsSync(join(repo, "pwned-b"))).toBe(false);
    expect(evidence).toContain("+export const v = 2;");
    expect(cage.wrapped.some((w) => w.args.includes(edited))).toBe(true);
  });
});

describe("defaultFindConsumers", () => {
  it("names the other files that reference a changed export", async () => {
    const repo = repoWith({ "a.ts": "export const sharedThing = 1;\n", "c.ts": "import { sharedThing } from './a';\n" });
    const out = await defaultFindConsumers(["sharedThing"], [join(repo, "a.ts")]);
    expect(out).toContain("- c.ts");
  });

  it("hands git a pattern carrying backticks as a pattern, never as a command", async () => {
    const repo = repoWith({ "a.ts": "export const a = 1;\n" });
    await defaultFindConsumers(["x`touch pwned-c`"], [join(repo, "a.ts")]);
    expect(existsSync(join(repo, "pwned-c"))).toBe(false);
    expect(cage.wrapped.some((w) => w.args.includes("x`touch pwned-c`"))).toBe(true);
  });
});
