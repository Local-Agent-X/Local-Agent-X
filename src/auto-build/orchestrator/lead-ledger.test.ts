// At the end of a build run its lead writes the run's ledger entry, from the
// run's record and the decisions on record, and the engine commits it.
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeLeadLedger } from "./lead-ledger.js";
import type { LoopResult } from "../loop/types.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-ledger-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  mkdirSync(join(dir, "spec"));
  writeFileSync(join(dir, "spec", "build-state.md"), "# Build state\n\n## Chunk 4 — Scan\n\nLanded by the build lead with a check owed to the owner: live scan on a phone\n");
  writeFileSync(join(dir, "spec", "ledger.md"), "# Label Check — build ledger\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const result: LoopResult = { status: "complete", lastChunk: 5, chunksCommitted: 2, haltReason: "", outcomes: [], events: [], openItems: ["the owner's walkthrough"] };

describe("writeLeadLedger", () => {
  it("asks the lead with the run's record and its decisions, then adds its report to spec/ledger.md and commits it", async () => {
    const dir = project();
    const ask = vi.fn(async (_lead: unknown, _s: { kind: string; evidence: string }) => ({ action: "accept" as const, reasoning: "r", report: "Chunks 4 and 5 landed. Owed to you: a live scan on a phone." }));
    expect(await writeLeadLedger({ projectDir: dir, originSessionId: "chat-origin", result, landed: [4, 5], totalChunks: 5, ask })).toBe(true);
    const asked = ask.mock.calls[0][1];
    expect(asked.kind).toBe("report");
    expect(asked.evidence).toContain("Chunks this run landed: 4, 5");
    expect(asked.evidence).toContain("check owed to the owner: live scan on a phone");
    expect(asked.evidence).toContain("- the owner's walkthrough");
    const ledger = readFileSync(join(dir, "spec", "ledger.md"), "utf-8");
    expect(ledger.startsWith("# Label Check — build ledger")).toBe(true);
    expect(ledger).toContain("(written by the build lead)\n\nChunks 4 and 5 landed. Owed to you: a live scan on a phone.");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("spec: the build lead's ledger entry for this run");
  });

  it("writes nothing when the lead gives no report, or the build has no lead", async () => {
    const dir = project();
    expect(await writeLeadLedger({ projectDir: dir, originSessionId: "chat-origin", result, landed: [], totalChunks: 5, ask: vi.fn(async () => null) })).toBe(false);
    expect(await writeLeadLedger({ projectDir: dir, originSessionId: "chat-origin", result, landed: [], totalChunks: 5, ask: vi.fn(async () => ({ action: "accept" as const, reasoning: "r" })) })).toBe(false);
    const neverAsked = vi.fn(async () => null);
    expect(await writeLeadLedger({ projectDir: dir, originSessionId: "orchestrator-abc", result, landed: [], totalChunks: 5, ask: neverAsked })).toBe(false);
    expect(neverAsked).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "spec", "ledger.md"), "utf-8")).toBe("# Label Check — build ledger\n");
    expect(existsSync(join(dir, "spec", "ledger.md"))).toBe(true);
  });
});
