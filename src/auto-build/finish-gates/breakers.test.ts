// The break-it agents: what they delivered with breaker_findings, and what one
// that delivered nothing counts as.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBreakers, PERSONAS } from "./breakers.js";

type Finding = { severity: "critical" | "high" | "medium" | "low"; text: string };
const found = (findings: Finding[]) => ({ stdout: "", exitCode: 0, durationMs: 1, breakerFindings: { findings } });

async function inProject<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lax-breakers-"));
  try { return await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("runBreakers", () => {
  it("sends one probe-only agent per angle and reads what each delivered", () => inProject(async (dir) => {
    const leak: Finding = { severity: "critical", text: "a second tab leaks the med list, src/store.ts:40" };
    const run = vi.fn(async (o: { role: string; title?: string; task: string }) => found(o.title?.includes("hostile") ? [leak] : []));
    const results = await runBreakers({ projectDir: dir, run: run as never });
    expect(run).toHaveBeenCalledTimes(PERSONAS.length);
    expect(new Set(run.mock.calls.map(([o]) => o.role))).toEqual(new Set(["finish-breaker"]));
    expect(run.mock.calls[0][0].task).toContain("End by calling breaker_findings");
    expect(results.find((r) => r.persona === "hostile")).toEqual({ persona: "hostile", status: "ran", findings: [leak] });
    expect(results.every((r) => r.status === "ran")).toBe(true);
    expect(existsSync(join(dir, ".skeptic"))).toBe(false);
  }));

  it("one that did not finish is asked once more, then did not check the app", () => inProject(async (dir) => {
    const run = vi.fn(async (o: { title?: string }) => o.title?.includes("unlucky")
      ? { stdout: "", exitCode: 1, durationMs: 1, error: "silent for 15 min" }
      : found([]));
    const results = await runBreakers({ projectDir: dir, run: run as never });
    expect(run).toHaveBeenCalledTimes(PERSONAS.length + 1);
    expect(results.find((r) => r.persona === "unlucky")).toMatchObject({ status: "not-run", note: "did not finish (exit 1: silent for 15 min)" });
    expect(results.filter((r) => r.status === "ran")).toHaveLength(PERSONAS.length - 1);
  }));

  // Findings typed into its last message are not findings: a list that did not
  // match "- [severity] text" used to be dropped without a word.
  it("one that answered in words and delivered nothing did not check the app, whatever it typed", () => inProject(async (dir) => {
    const run = vi.fn(async () => ({ stdout: "FINDINGS: none", exitCode: 0, durationMs: 1 }));
    const results = await runBreakers({ projectDir: dir, run: run as never });
    expect(results.every((r) => r.status === "not-run" && r.note === "ended its run without reporting its findings")).toBe(true);
  }));

  it("findings it delivered stand though its run then failed", () => inProject(async (dir) => {
    const run = vi.fn(async () => ({ ...found([{ severity: "low", text: "button label clips" }]), exitCode: 124, error: "timed out" }));
    const results = await runBreakers({ projectDir: dir, run: run as never });
    expect(run).toHaveBeenCalledTimes(PERSONAS.length);
    expect(results.every((r) => r.status === "ran" && r.findings.length === 1)).toBe(true);
  }));
});
