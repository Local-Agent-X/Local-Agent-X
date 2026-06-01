/**
 * extractSessionPairs regression tests.
 *
 * Focus: harness scaffolding (<system-reminder> blocks, anti-loop nudges)
 * injected into a session transcript must be stripped at the reader so it
 * never reaches consolidation (dream) or the searchable index. A pair that
 * is nothing but scaffolding drops out entirely.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSessionPairs } from "./chunking.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-chunk-"));
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function writeSession(rows: unknown[]): string {
  const path = join(tempDir, "sess.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"), "utf-8");
  return path;
}

describe("extractSessionPairs scaffolding strip", () => {
  it("strips system-reminder blocks but keeps the real user text", () => {
    const path = writeSession([
      { kind: "meta", title: "t", createdAt: 1 },
      { kind: "msg", message: { role: "user", content: "<system-reminder>Background context you should ignore.</system-reminder>\nBuy the Bambu P1S for the glasses parts." } },
      { kind: "msg", message: { role: "assistant", content: "Got it — ordering the P1S." } },
    ]);

    const pairs = extractSessionPairs(path);
    const user = pairs.find((p) => p.role === "user");
    expect(user).toBeDefined();
    expect(user!.content).not.toContain("system-reminder");
    expect(user!.content).not.toContain("Background context");
    expect(user!.content).toContain("Bambu P1S");
  });

  it("drops a message that is nothing but scaffolding", () => {
    const path = writeSession([
      { kind: "meta", title: "t", createdAt: 1 },
      { kind: "msg", message: { role: "user", content: "<system-reminder>stop searching and produce your final output.</system-reminder>" } },
      { kind: "msg", message: { role: "assistant", content: "Here is the final answer with real substance." } },
    ]);

    const pairs = extractSessionPairs(path);
    expect(pairs.find((p) => p.role === "user")).toBeUndefined();
    expect(pairs.some((p) => p.content.includes("real substance"))).toBe(true);
  });
});
