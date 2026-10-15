// The habit-tracker build (2026-10-14): every edited file was TypeScript, plain
// `node` can't load a .ts module, so the spec probe came back INVALID and was thrown
// away after ~17s of authoring. Probes now run under tsx, and only target the
// modules they can load: a component (.tsx) or a module that imports CSS needs the
// app's bundler.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeTargets, runProbe, runSpecProbeGate, _resetSpecProbeState } from "./spec-probes.js";
import type { OracleProbe } from "../../classifiers/oracle-probe-gen.js";
import type { Op } from "../../ops/types.js";

const op = (id: string) => ({ id } as Op);
let dir = "";

beforeEach(() => {
  _resetSpecProbeState();
  dir = mkdtempSync(join(tmpdir(), "spec-probe-ts-"));
  writeFileSync(join(dir, "streaks.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  writeFileSync(join(dir, "App.tsx"), "export function App(): null {\n  return null;\n}\n");
  writeFileSync(join(dir, "theme.ts"), "import './theme.css';\nexport const accent = 'blue';\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("probe targets", () => {
  it("a JS/TS project probes only plain modules; other projects keep every file", () => {
    const files = ["streaks.ts", "App.tsx", "theme.ts"].map((f) => join(dir, f));
    expect(probeTargets(files)).toEqual([join(dir, "streaks.ts")]);
    expect(probeTargets(["/p/a.py", "/p/b.go"])).toEqual(["/p/a.py", "/p/b.go"]);
  });

  it("edits that touched only components are not probed at all (no authoring call)", async () => {
    const generate = vi.fn(async (): Promise<OracleProbe | null> => ({ language: "node", script: "" }));
    const exec = vi.fn(async () => ({ verdict: "red" as const, output: "AssertionError" }));
    const r = await runSpecProbeGate(op("ui-only"), { editedPaths: [join(dir, "App.tsx"), join(dir, "theme.ts")], generate, exec });
    expect(r.shouldRetry).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("the tsx runner (runProbe, through the real harness shell)", () => {
  // A Vite app's package.json declares ESM; tsx loads its .ts modules as ESM.
  beforeEach(() => writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" })));
  const probeFor = (expected: number): OracleProbe => ({
    language: "node",
    script: `import assert from "node:assert";\nimport { add } from "./streaks";\nassert.strictEqual(add(2, 2), ${expected});\n`,
  });

  it("loads a TypeScript module: a satisfied probe passes", async () => {
    const run = await runProbe(probeFor(4), dir, "tsx-pass");
    expect(run.verdict, run.output).toBe("pass");
  }, 60_000);

  it("and a tripped assertion is red, so the gate nudges", async () => {
    expect((await runProbe(probeFor(5), dir, "tsx-red")).verdict).toBe("red");
    const r = await runSpecProbeGate(op("tsx-red-gate"), {
      editedPaths: [join(dir, "streaks.ts")],
      workspaceRoot: join(dir, "not-the-root"),
      generate: vi.fn(async () => probeFor(5)),
    });
    expect(r.shouldRetry).toBe(true);
    expect(r.nudge).toContain("AssertionError");
  }, 60_000);
});
