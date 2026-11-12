import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readToolFailures } from "./tool-usage-telemetry.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tool-usage-"));
  file = join(dir, "tool-usage.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const failure = { signature: "abcdef0123456789", reason: "python3: command not found", opId: "op_1", toolCallId: "c1" };
const line = (row: Record<string, unknown>) => JSON.stringify(row) + "\n";

describe("readToolFailures", () => {
  it("is empty when nothing was ever logged", async () => {
    expect(await readToolFailures(0, file)).toEqual([]);
  });

  it("returns only lines that say which failure they were, since the cutoff", async () => {
    writeFileSync(file, [
      line({ ts: "2026-11-01T10:00:00.000Z", tool: "bash", status: "ok", sessionId: "s1" }),
      // Written before failures were identified: an error, but not a countable one.
      line({ ts: "2026-11-02T10:00:00.000Z", tool: "bash", status: "error", sessionId: "s1" }),
      line({ ts: "2026-11-03T10:00:00.000Z", tool: "bash", status: "error", sessionId: "s2", failure }),
      line({ ts: "2026-11-09T10:00:00.000Z", tool: "office", action: "read", status: "timeout", sessionId: "s3", failure }),
    ].join(""));
    const since = Date.parse("2026-11-05T00:00:00.000Z");
    expect(await readToolFailures(since, file)).toEqual([
      { at: Date.parse("2026-11-09T10:00:00.000Z"), tool: "office", action: "read", status: "timeout", sessionId: "s3", failure },
    ]);
    expect(await readToolFailures(0, file)).toHaveLength(2);
  });

  it("survives a torn last line and a line with no usable time", async () => {
    writeFileSync(file,
      line({ ts: "2026-11-03T10:00:00.000Z", tool: "bash", status: "error", failure })
      + line({ ts: "not a date", tool: "bash", status: "error", failure })
      + '{"ts":"2026-11-04T10:00:00.000Z","tool":"bash","status":"error","failure":{"signa');
    expect(await readToolFailures(0, file)).toHaveLength(1);
  });
});
