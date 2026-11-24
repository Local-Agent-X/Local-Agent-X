// The break-it agents' answer, read from their last message.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBreakerFindings, runBreakers, PERSONAS } from "./breakers.js";

describe("parseBreakerFindings", () => {
  it("reads one finding per line with its severity", () => {
    expect(parseBreakerFindings("Tried a lot.\n\nFINDINGS:\n- [critical] a second tab leaks the med list, src/store.ts:40\n- [low] button label clips")).toEqual([
      { severity: "critical", text: "a second tab leaks the med list, src/store.ts:40" },
      { severity: "low", text: "button label clips" },
    ]);
  });

  it("none is a clean answer; no block at all is no answer", () => {
    expect(parseBreakerFindings("FINDINGS: none")).toEqual([]);
    expect(parseBreakerFindings("I looked around and it seems fine.")).toBeNull();
  });

  it("the last block wins when the format is quoted first", () => {
    const raw = "The format is FINDINGS: - [high] <x>\n...\nFINDINGS:\n- [medium] DSLD timeout never fires, src/dsld.ts:12";
    expect(parseBreakerFindings(raw)).toEqual([{ severity: "medium", text: "DSLD timeout never fires, src/dsld.ts:12" }]);
  });
});

describe("runBreakers", () => {
  it("sends one probe-only agent per angle, and one that does not answer did not check the app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-breakers-"));
    const run = vi.fn(async (o: { role: string; title?: string }) => o.title?.includes("unlucky")
      ? { stdout: "", exitCode: 1, durationMs: 1, error: "silent for 15 min" }
      : { stdout: "FINDINGS: none", exitCode: 0, durationMs: 1 });
    try {
      const results = await runBreakers({ projectDir: dir, run: run as never });
      expect(run).toHaveBeenCalledTimes(PERSONAS.length);
      expect(new Set(run.mock.calls.map(([o]) => o.role))).toEqual(new Set(["finish-breaker"]));
      expect(results.find((r) => r.persona === "unlucky")).toMatchObject({ status: "not-run", note: "did not finish (exit 1: silent for 15 min)" });
      expect(results.filter((r) => r.status === "ran")).toHaveLength(PERSONAS.length - 1);
      expect(existsSync(join(dir, ".skeptic"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
