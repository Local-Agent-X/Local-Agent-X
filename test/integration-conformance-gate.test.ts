/**
 * Contract test for the plug-and-play conformance gate itself.
 *
 * The gate's value depends entirely on it being a RATCHET: today's known
 * violations are held in a baseline, a NEW violation fails the build, and a
 * baseline entry that stops reproducing also fails so the list can only shrink.
 * If any of those three properties silently broke, the gate would keep printing
 * "OK" while the registry drifted back to model-locked. Hence this test.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(root, "scripts/check-integration-conformance.mjs");
const BASELINE = join(root, "scripts/integration-conformance-baseline.json");

function runGate() {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd: root });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Run the gate against a mutated baseline, always restoring the original. */
function withBaseline(mutate: (b: { known: { id: string; note?: string }[] }) => void) {
  const original = readFileSync(BASELINE, "utf8");
  try {
    const parsed = JSON.parse(original);
    mutate(parsed);
    writeFileSync(BASELINE, JSON.stringify(parsed, null, 2), "utf8");
    return runGate();
  } finally {
    writeFileSync(BASELINE, original, "utf8");
  }
}

describe("integration conformance gate", () => {
  it("passes on the current tree and reports the known backlog", () => {
    const { code, out } = runGate();
    expect(code).toBe(0);
    expect(out).toMatch(/check-integration-conformance: OK/);
    // The backlog must stay visible — a silent pass would hide the debt.
    expect(out).toMatch(/KNOWN violation\(s\) held in the baseline/);
  });

  it("audits every registered builtin integration", () => {
    const { out } = runGate();
    const count = Number(out.match(/OK \((\d+) integrations/)?.[1]);
    const index = readFileSync(join(root, "src/integrations/builtins/index.ts"), "utf8");
    const registered = [...index.matchAll(/^\s*(\w+Integration),$/gm)].length;
    expect(count).toBe(registered);
    expect(count).toBeGreaterThanOrEqual(11);
  });

  it("fails when a known violation is no longer baselined (new violation)", () => {
    const { code, out } = withBaseline((b) => { b.known = b.known.slice(1); });
    expect(code).toBe(1);
    expect(out).toMatch(/new plug-and-play violation/);
  });

  it("fails on a stale baseline entry so the list can only shrink", () => {
    const { code, out } = withBaseline((b) => {
      b.known.push({ id: "steer:a_tool_that_does_not_exist", note: "synthetic" });
    });
    expect(code).toBe(1);
    expect(out).toMatch(/no longer reproduce/);
  });

  it("restores the baseline after mutation", () => {
    const parsed = JSON.parse(readFileSync(BASELINE, "utf8"));
    expect(parsed.known.length).toBeGreaterThan(0);
    expect(runGate().code).toBe(0);
  });
});
