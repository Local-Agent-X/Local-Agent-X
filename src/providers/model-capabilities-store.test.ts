/**
 * model-capabilities-store tests — the persistence + seed guarantees that make
 * the registry self-healing without phoning home.
 *
 * Each test runs against a throwaway LAX_DATA_DIR so it never touches the real
 * ~/.lax, and calls _resetForTests() to simulate a process restart (drop the
 * in-memory layer, forcing a reload from disk + seed).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hasNoTools,
  recordNoTools,
  hasUnsupportedParam,
  recordUnsupportedParam,
  _resetForTests,
} from "./model-capabilities-store.js";
import {
  hasNoToolSupport,
  markNoToolSupport,
  hasParamUnsupported,
  markParamUnsupported,
} from "./types.js";

const LOCAL = "http://localhost:11434/v1";
const CLOUD = "https://ollama.com/v1";
const XAI = "https://api.x.ai/v1";

let dir: string;
const prevEnv = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-caps-"));
  process.env.LAX_DATA_DIR = dir;
  _resetForTests();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  _resetForTests();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("persistence — facts survive a restart", () => {
  it("a learned no-tool fact reloads from disk", () => {
    expect(hasNoTools(LOCAL, "qwen2:7b")).toBe(false);
    recordNoTools(LOCAL, "qwen2:7b");
    expect(existsSync(join(dir, "model-capabilities.json"))).toBe(true);

    _resetForTests(); // simulate a restart — in-memory layer dropped
    expect(hasNoTools(LOCAL, "qwen2:7b")).toBe(true);
  });

  it("a learned unsupported-param reloads from disk and unions with the seed", () => {
    recordUnsupportedParam("https://api.openai.com/v1", "o3-pro", "temperature");
    _resetForTests();
    expect(hasUnsupportedParam("https://api.openai.com/v1", "o3-pro", "temperature")).toBe(true);
    // The shipped seed fact is still there after the reload.
    expect(hasUnsupportedParam(XAI, "grok-4.20-0309-reasoning", "reasoning_effort")).toBe(true);
  });
});

describe("public seed — correct day-one without phoning home", () => {
  it("the seeded grok reasoning_effort rejection is known on a fresh store", () => {
    expect(hasUnsupportedParam(XAI, "grok-4.20-0309-reasoning", "reasoning_effort")).toBe(true);
  });

  it("a read-only seed fact does not write a user file", () => {
    // Only a runtime observation should create ~/.lax/model-capabilities.json.
    expect(hasUnsupportedParam(XAI, "grok-4.20-0309-reasoning", "reasoning_effort")).toBe(true);
    expect(existsSync(join(dir, "model-capabilities.json"))).toBe(false);
  });
});

describe("(baseURL, model) keying — AUDIT Critical #4 guard", () => {
  it("a no-tool finding on a local endpoint does not poison the same model in the cloud", () => {
    recordNoTools(LOCAL, "qwen2:7b");
    expect(hasNoTools(LOCAL, "qwen2:7b")).toBe(true);
    expect(hasNoTools(CLOUD, "qwen2:7b")).toBe(false);
  });
});

describe("resilience — a bad file never breaks a turn", () => {
  it("corrupt JSON falls back to an empty learned layer with the seed intact", () => {
    writeFileSync(join(dir, "model-capabilities.json"), "{ not valid json", "utf-8");
    _resetForTests();
    expect(() => hasNoTools(LOCAL, "anything")).not.toThrow();
    expect(hasNoTools(LOCAL, "anything")).toBe(false);
    expect(hasUnsupportedParam(XAI, "grok-4.20-0309-reasoning", "reasoning_effort")).toBe(true);
  });
});

describe("types.ts wrappers delegate to the same persistent store", () => {
  it("markNoToolSupport persists through and reloads via hasNoToolSupport", () => {
    markNoToolSupport(LOCAL, "llama3");
    _resetForTests();
    expect(hasNoToolSupport(LOCAL, "llama3")).toBe(true);
  });

  it("markParamUnsupported persists through and reloads via hasParamUnsupported", () => {
    markParamUnsupported("https://api.openai.com/v1", "o3-pro", "temperature");
    _resetForTests();
    expect(hasParamUnsupported("https://api.openai.com/v1", "o3-pro", "temperature")).toBe(true);
  });
});
