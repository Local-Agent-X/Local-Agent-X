import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCapabilityGap, capabilityGapsPath, readCapabilityGaps } from "./capability-gaps.js";

describe("capability-gap log", () => {
  const originalDataDir = process.env.LAX_DATA_DIR;
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lax-gaps-"));
    process.env.LAX_DATA_DIR = join(root, "data");
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = originalDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("reads nothing before the first gap, then every appended line in order", () => {
    expect(readCapabilityGaps()).toEqual([]);
    appendCapabilityGap({ sessionId: "s1", timestamp: 1, summary: "memory_search misses synced sessions", toolsTried: ["memory_search"] });
    appendCapabilityGap({ sessionId: "s2", timestamp: 2, summary: "no tool reads Outlook rules", toolsTried: [], workaround: "browser" });
    expect(readCapabilityGaps().map((g) => g.sessionId)).toEqual(["s1", "s2"]);
    expect(readCapabilityGaps()[1].workaround).toBe("browser");
  });

  it("skips a torn last line instead of failing the whole read", () => {
    appendCapabilityGap({ sessionId: "s1", timestamp: 1, summary: "ok", toolsTried: [] });
    appendFileSync(capabilityGapsPath(), '{"sessionId":"s2","timesta');
    expect(readCapabilityGaps().map((g) => g.sessionId)).toEqual(["s1"]);
  });
});
