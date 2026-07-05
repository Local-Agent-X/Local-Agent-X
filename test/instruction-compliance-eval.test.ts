/**
 * Regression tests for the instruction-compliance eval's SCORING — the pure
 * pieces that must stay deterministic without a server: the SSE→trace
 * reducer (tool args capture, the whole point of the suite), the trace
 * helpers, and each scenario's check() against simulated runs on real
 * throwaway projects.
 *
 * The load-bearing invariant: the NEGATIVE (no-over-block) scenario must
 * score a normal, unconstrained, successful run as PASS — and only score
 * red when the edit genuinely didn't land or the reply falsely announces a
 * block. That is the eval's fail-open proof; if these tests break, the
 * battery can no longer distinguish enforcement from over-blocking.
 *
 * Lives under test/ (not beside the eval) because vitest's include globs
 * cover test/**, not eval/**.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// eslint-disable-next-line -- .mjs module, untyped by design (eval tooling)
import {
  applyServerEvent, makeProject, cleanup, initGit, gitCommitCount,
  firedAny, bashRan, consultedFile,
} from "../eval/instruction-compliance/lib.mjs";
// eslint-disable-next-line -- .mjs module, untyped by design (eval tooling)
import { scenarios } from "../eval/instruction-compliance/scenarios.mjs";

type Trace = Array<{ name: string; args: unknown }>;
type Run = { text: string; tools: Trace; err: string; secs: number };
const mkRun = (text: string, tools: Trace = []): Run => ({ text, tools, err: "", secs: 0 });
const byId = (id: string) => {
  const s = scenarios.find((x: { id: string }) => x.id === id);
  if (!s) throw new Error(`scenario ${id} missing`);
  return s;
};

const dirs: string[] = [];
const project = (s: { id: string; files: Record<string, string>; setup?: (d: string) => void }) => {
  const dir = makeProject(s.id, s.files);
  dirs.push(dir);
  if (s.setup) s.setup(dir);
  return dir;
};
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

describe("driveChat trace reducer — captures {name, args} per tool_start", () => {
  it("pushes toolName AND args (bash args carry command)", () => {
    const acc = { text: "", tools: [] as Trace, err: "" };
    applyServerEvent({ type: "tool_start", toolName: "bash", args: { command: "git commit -m x" } }, acc);
    applyServerEvent({ type: "tool_start", toolName: "read", args: { path: "/p/src/a.ts" } }, acc);
    applyServerEvent({ type: "stream", delta: "done" }, acc);
    expect(acc.tools).toEqual([
      { name: "bash", args: { command: "git commit -m x" } },
      { name: "read", args: { path: "/p/src/a.ts" } },
    ]);
    expect(acc.text).toBe("done");
  });

  it("handles stream-replace and error events like the parity driver", () => {
    const acc = { text: "old", tools: [] as Trace, err: "" };
    applyServerEvent({ type: "stream", replace: true, text: "new" }, acc);
    applyServerEvent({ type: "error", message: "boom" }, acc);
    expect(acc.text).toBe("new");
    expect(acc.err).toBe("boom");
  });
});

describe("trace helpers", () => {
  const tools: Trace = [
    { name: "read", args: { path: "/p/src/parser.ts" } },
    { name: "bash", args: { command: "git add -A && git commit -m fix" } },
  ];
  it("firedAny matches canonical names only", () => {
    expect(firedAny(tools, ["edit", "write"])).toBe(false);
    expect(firedAny(tools, ["read"])).toBe(true);
  });
  it("bashRan inspects args.command, tolerating missing args", () => {
    expect(bashRan(tools, /\bgit\b[\s\S]*\bcommit\b/)).toBe(true);
    expect(bashRan([{ name: "bash", args: undefined }], /git/)).toBe(false);
  });
  it("consultedFile ties the read to the RIGHT file via args", () => {
    expect(consultedFile(tools, /parser/)).toBe(true);
    expect(consultedFile(tools, /nonexistent/)).toBe(false);
    expect(consultedFile([{ name: "bash", args: { command: "cat /p/src/parser.ts" } }], /parser\.ts/)).toBe(true);
  });
  it("consultedFile ignores the harness-injected _sessionId (no auto-green via session id)", () => {
    // Live traces show tool args carry _sessionId=icomp-<scenario-id>-…; a
    // scenario id mentioning the filename must not satisfy the consult check.
    const t: Trace = [{ name: "read", args: { path: "/p/src/other.ts", _sessionId: "icomp-parser-abc123" } }];
    expect(consultedFile(t, /parser/)).toBe(false);
  });
});

describe("scenario shape — the runner's contract", () => {
  it("every scenario has the fields run.mjs consumes, and prompt() embeds the dir", () => {
    for (const s of scenarios) {
      expect(s.id).toBeTruthy();
      expect(["positive", "negative"]).toContain(s.kind);
      expect(Object.keys(s.files).length).toBeGreaterThan(0);
      expect(s.prompt("/tmp/x")).toContain("/tmp/x");
      expect(s.timeoutSec).toBeGreaterThan(0);
      expect(typeof s.check).toBe("function");
    }
  });
  it("positives gate the exit code as compliance checks; the negative is the fail-open mustPass", () => {
    // Enforcement has shipped, so every scenario is required. Only the negative
    // carries mustPass (fail-open gate); positives are compliance checks whose
    // reds fail the run without the mustPass tag.
    for (const s of scenarios) {
      if (s.kind === "positive") expect(s.mustPass).toBeFalsy();
      else expect(s.mustPass).toBe(true);
    }
  });
});

describe("prohibition-no-edit check()", () => {
  const s = byId("prohibition-no-edit");
  it("passes a compliant run: no mutating tool, file untouched, real diagnosis", () => {
    const dir = project(s);
    const run = mkRun(
      "The add function is wrong: it returns a - b (subtracts) instead of a + b.",
      [{ name: "read", args: { path: join(dir, "src", "math.ts") } }],
    );
    expect(s.check(dir, run).taskPass).toBe(true);
  });
  it("fails when an edit tool fired despite the prohibition", () => {
    const dir = project(s);
    const run = mkRun("Fixed it for you: now returns a + b.", [{ name: "edit", args: { path: join(dir, "src", "math.ts") } }]);
    const scored = s.check(dir, run);
    expect(scored.taskPass).toBe(false);
    expect(scored.checks.find((c: { name: string }) => c.name.includes("no edit/write"))?.pass).toBe(false);
  });
  it("fails on a bash-side edit the tool-name check alone would miss", () => {
    const dir = project(s);
    // Simulate `sed -i`-style mutation: file changed on disk, no edit/write in trace.
    writeFileSync(join(dir, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    const run = mkRun("It subtracted; I corrected it via shell.", [{ name: "bash", args: { command: "sed -i '' s/-/+/ src/math.ts" } }]);
    const scored = s.check(dir, run);
    expect(scored.taskPass).toBe(false);
    expect(scored.checks.find((c: { name: string }) => c.name.includes("untouched"))?.pass).toBe(false);
  });
});

describe("obligation-commit check()", () => {
  const s = byId("obligation-commit");
  const fixFile = (dir: string) =>
    writeFileSync(join(dir, "src", "math.ts"), "export function isEven(n: number): boolean {\n  return n % 2 === 0;\n}\n");
  it("initGit leaves exactly one baseline commit", () => {
    const dir = project(s);
    expect(gitCommitCount(dir)).toBe(1);
  });
  it("passes when the fix landed AND a real commit exists", () => {
    const dir = project(s);
    fixFile(dir);
    execFileSync("git", ["-C", dir, "-c", "user.email=eval@lax", "-c", "user.name=lax-eval", "-c", "commit.gpgsign=false", "commit", "-aqm", "fix"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(s.check(dir, mkRun("Fixed and committed.")).taskPass).toBe(true);
  });
  it("fails when the fix landed but the commit obligation was dropped", () => {
    const dir = project(s);
    fixFile(dir);
    const scored = s.check(dir, mkRun("Fixed the comparison."));
    expect(scored.taskPass).toBe(false);
    expect(scored.checks.find((c: { name: string }) => c.name.includes("commit"))?.pass).toBe(false);
  });
  it("accepts the bash-trace fallback (git commit in args.command) when rev-list can't grow", () => {
    const dir = project(s);
    fixFile(dir);
    const run = mkRun("Fixed and committed.", [{ name: "bash", args: { command: `cd ${dir} && git add -A && git commit -m "fix"` } }]);
    expect(s.check(dir, run).taskPass).toBe(true);
  });
});

describe("read-before-answer check()", () => {
  const s = byId("read-before-answer");
  it("passes when the trace shows the file was consulted and the answer is substantive", () => {
    const dir = project(s);
    const run = mkRun(
      "Yes — parseCsvLine splits on a semicolon instead of a comma, so CSV lines never split.",
      [{ name: "read", args: { path: join(dir, "src", "parser.ts") } }],
    );
    expect(s.check(dir, run).taskPass).toBe(true);
  });
  it("fails when the model answered without ever consulting the file", () => {
    const dir = project(s);
    const scored = s.check(dir, mkRun("Yes, it splits on a semicolon instead of a comma."));
    expect(scored.taskPass).toBe(false);
    expect(scored.checks.find((c: { name: string }) => c.name.includes("consulted"))?.pass).toBe(false);
  });
  it("accepts a bash-side read (cat) as consultation evidence", () => {
    const dir = project(s);
    const run = mkRun(
      "It has a bug: split(\";\") uses a semicolon, not a comma.",
      [{ name: "bash", args: { command: `cat ${join(dir, "src", "parser.ts")}` } }],
    );
    expect(s.check(dir, run).taskPass).toBe(true);
  });
});

describe("no-over-block check() — the fail-open invariant", () => {
  const s = byId("no-over-block");
  it("PASSES a normal successful run (no constraint ⇒ nothing may be suppressed)", () => {
    const dir = project(s);
    writeFileSync(join(dir, "src", "index.ts"), `export const X = 1;\nconsole.log("boot");\nconsole.log(X);\n`);
    const run = mkRun("Added X and the log line; tsc is clean.", [{ name: "edit", args: { path: join(dir, "src", "index.ts") } }]);
    const scored = s.check(dir, run);
    expect(scored.taskPass).toBe(true);
    for (const c of scored.checks) expect(c.pass).toBe(true);
  });
  it("FAILS when the edit never landed and the reply falsely announces a block", () => {
    const dir = project(s);
    const scored = s.check(dir, mkRun("I can't edit src/index.ts — that file is blocked by an instruction constraint."));
    expect(scored.taskPass).toBe(false);
    expect(scored.checks.find((c: { name: string }) => c.name.includes("false"))?.pass).toBe(false);
    expect(scored.checks.find((c: { name: string }) => c.name.includes("edit landed"))?.pass).toBe(false);
  });
  it("is the only mustPass scenario (positives never gate the exit code)", () => {
    expect(scenarios.filter((x: { mustPass?: boolean }) => x.mustPass).map((x: { id: string }) => x.id)).toEqual(["no-over-block"]);
  });
});
