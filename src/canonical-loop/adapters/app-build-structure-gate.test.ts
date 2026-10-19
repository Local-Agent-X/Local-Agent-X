// The done-claim structure gate adopts the kit for a new build whose project
// the model scaffolded itself (a creator the harness does not run), then runs
// the project's own check; a directory with no project is never touched, and
// without the adoption flag nothing is adopted. The harness command runner is
// stubbed: the kit's own scripts are proven in src/app-scaffold.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const harness = vi.hoisted(() => ({ commands: [] as Array<{ command: string; cwd: string; opId: string }>, ok: true, output: "check-structure: OK" }));
vi.mock("../../tool-execution/index.js", () => ({
  executeHarnessCommand: async (req: { command: string; cwd: string; opId: string }) => {
    harness.commands.push({ command: req.command, cwd: req.cwd, opId: req.opId });
    return harness.ok ? { ok: true, status: "ok", output: harness.output } : { ok: false, status: "ok", output: "src/big.ts: 460 code lines (cap 400)" };
  },
}));

import { runAppStructureGate } from "./app-build-structure-gate.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-structure-gate-")); harness.commands = []; harness.ok = true; harness.output = "check-structure: OK"; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (rel: string, text = "") => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

function nextProject(): void {
  file("package.json", JSON.stringify({ name: "site", dependencies: { next: "15.0.0", react: "19.0.0" } }));
  file("next.config.ts", "export default {};\n");
  file("app/page.tsx", "export default function Page() { return null; }\n");
}

describe("runAppStructureGate", () => {
  it("a new build's self-scaffolded project gets the kit, then its own check runs", async () => {
    nextProject();
    const outcome = await runAppStructureGate(dir, "op_1", { adoptKit: { projectName: "site" } });
    expect(outcome).toEqual({ kind: "passed" });
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "scripts", "check-structure.mjs"))).toBe(true);
    expect(harness.commands).toEqual([{ command: "node scripts/check-structure.mjs", cwd: dir, opId: "op_1" }]);
  });

  it("without the adoption flag (an update) a kit-less project is left alone and skipped", async () => {
    nextProject();
    expect(await runAppStructureGate(dir, "op_1")).toEqual({ kind: "skipped" });
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(harness.commands).toEqual([]);
  });

  it("a new build with no project on disk (a static page) is never given the kit", async () => {
    file("index.html", "<!doctype html>");
    expect(await runAppStructureGate(dir, "op_1", { adoptKit: { projectName: "page" } })).toEqual({ kind: "skipped" });
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("a failing check after adoption is the model's fix list", async () => {
    nextProject();
    harness.ok = false;
    const outcome = await runAppStructureGate(dir, "op_1", { adoptKit: { projectName: "site" } });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.detail).toContain("src/big.ts: 460 code lines (cap 400)");
    expect(outcome.kind === "failed" && outcome.detail).toContain("move it into a module named after that job");
  });

  it("a passing check that lists items nearing a size cap passes with a note for the next turn", async () => {
    nextProject();
    harness.output = [
      "Nearing the size cap (a warning; it never fails):",
      "  app/page.tsx: 330 code lines (cap 400)",
      "  When one of these grows, ...",
      "check-structure: OK",
    ].join("\n");
    const outcome = await runAppStructureGate(dir, "op_1", { adoptKit: { projectName: "site" } });
    expect(outcome.kind).toBe("passed");
    expect(outcome.kind === "passed" && outcome.note).toContain("app/page.tsx: 330 code lines (cap 400)");
  });
});
