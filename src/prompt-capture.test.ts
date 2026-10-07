import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measurePromptSection } from "./prompt-telemetry.js";
import { capturePromptSection, promptCaptureDir, purgeExpiredCaptures, resetPromptCaptureForTest } from "./prompt-capture.js";

// The 2026-10-05 flip-flop could not be diagnosed: op records said how big each
// prompt section was, never what it held. These pin the capture that closes
// that gap without turning the user's private memory into a log.
describe("prompt section capture", () => {
  const prev = { data: process.env.LAX_DATA_DIR, flag: process.env.LAX_PROMPT_CAPTURE };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-prompt-capture-"));
    process.env.LAX_DATA_DIR = dir;
    delete process.env.LAX_PROMPT_CAPTURE;
    resetPromptCaptureForTest();
  });
  afterEach(() => {
    if (prev.data === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev.data;
    if (prev.flag === undefined) delete process.env.LAX_PROMPT_CAPTURE; else process.env.LAX_PROMPT_CAPTURE = prev.flag;
    rmSync(dir, { recursive: true, force: true });
  });

  it("every measurement carries a sha256 of its text; the telemetry stays content-free", () => {
    const m = measurePromptSection("relevant-memories", "dynamic", "the text from her sister");
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(measurePromptSection("relevant-memories", "dynamic", "the text from her sister").sha256).toBe(m.sha256);
    expect(measurePromptSection("relevant-memories", "dynamic", "something else").sha256).not.toBe(m.sha256);
    expect(JSON.stringify(m)).not.toContain("sister");
  });

  it("writes nothing unless LAX_PROMPT_CAPTURE=1", () => {
    measurePromptSection("relevant-memories", "dynamic", "private memory");
    expect(existsSync(promptCaptureDir())).toBe(false);
  });

  it("with the flag, an op record's section hash resolves to the text the model was given", () => {
    process.env.LAX_PROMPT_CAPTURE = "1";
    const m = measurePromptSection("relevant-memories", "dynamic", "the text from her sister");
    expect(readFileSync(join(promptCaptureDir(), `${m.sha256}.txt`), "utf8")).toBe("the text from her sister");
  });

  it("is owner-only on disk and redacts secrets before the write", () => {
    process.env.LAX_PROMPT_CAPTURE = "1";
    const key = "sk-ant-api03-" + "a".repeat(93) + "AA";
    const m = measurePromptSection("context-block", "dynamic", `key is ${key}`);
    const file = join(promptCaptureDir(), `${m.sha256}.txt`);
    expect(readFileSync(file, "utf8")).not.toContain(key);
    if (process.platform !== "win32") {
      expect(statSync(promptCaptureDir()).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("stores a section that does not change between turns once", () => {
    process.env.LAX_PROMPT_CAPTURE = "1";
    for (let i = 0; i < 3; i++) measurePromptSection("core-identity/memory", "static", "same every turn");
    expect(readdirSync(promptCaptureDir())).toHaveLength(1);
  });

  it("purges captures older than the 7-day retention, keeps fresh ones", () => {
    process.env.LAX_PROMPT_CAPTURE = "1";
    const old = measurePromptSection("a", "dynamic", "old").sha256;
    const fresh = measurePromptSection("b", "dynamic", "fresh").sha256;
    const eightDaysAgo = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(join(promptCaptureDir(), `${old}.txt`), eightDaysAgo, eightDaysAgo);
    expect(purgeExpiredCaptures()).toBe(1);
    expect(readdirSync(promptCaptureDir())).toEqual([`${fresh}.txt`]);
  });

  it("a failed write never throws into the turn", () => {
    process.env.LAX_PROMPT_CAPTURE = "1";
    process.env.LAX_DATA_DIR = "/dev/null/not-a-dir";
    expect(() => capturePromptSection("0".repeat(64), "text")).not.toThrow();
  });
});
