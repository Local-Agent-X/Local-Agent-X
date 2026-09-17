/**
 * A tool that times out reaches the model as a timeout — never as a harness failure.
 *
 * muse, wordy, 2026-09-17: `find / -name wordy_test.py` ran into bash's 120s
 * deadline. The runner's own 120s backstop fired first, reconcile() marked the
 * journaled call ambiguous and released its claim, and complete() then looked
 * for that claim, threw "side-effect journal claim lost", and the model was
 * told "bash failed inside the harness". It concluded its tools were broken
 * and stopped short of a fix it had already worked out.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// The operations root is fixed when the op store is first imported, so the
// data dir is set before any import below. Hoisted code runs before imports
// resolve, so the path comes from the environment alone; the journal creates
// the directories itself.
const env = vi.hoisted(() => {
  const prev = process.env.LAX_DATA_DIR;
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  const dir = `${base}/lax-journal-timeout-${process.pid}-${Date.now()}`;
  process.env.LAX_DATA_DIR = dir;
  return { dir, prev };
});
import type { ToolDefinition } from "../types.js";
import type { ToolCallContext } from "./context.js";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { backstopMs } from "./tool-runner.js";
import { getToolTimeout } from "./tool-timeout.js";

const dataDir = env.dir;
afterAll(() => {
  if (env.prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = env.prev;
  rmSync(dataDir, { recursive: true, force: true });
});
afterEach(() => { vi.useRealTimers(); });

function context(tool: ToolDefinition, args: Record<string, unknown>, operationId: string): ToolCallContext {
  return {
    tc: { id: "call_hang", name: tool.name, arguments: JSON.stringify(args) },
    toolMap: new Map([[tool.name, tool]]),
    security: {} as ToolCallContext["security"],
    callContext: "local",
    args,
    tool,
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [],
    sessionId: `journal-timeout-${Math.random()}`,
    operationId,
  };
}

const hangingBash = (): ToolDefinition => ({
  name: "bash",
  description: "test",
  parameters: {},
  effect: { class: "non-idempotent" },
  execute: () => new Promise(() => { /* never settles */ }),
});

describe("a journaled call that times out", () => {
  it("is reported as a timeout, and the journal still records it as ambiguous", async () => {
    vi.useFakeTimers();
    const op = `op_timeout_${Date.now()}`;
    const ctx = context(hangingBash(), { command: "find / -name x" }, op);
    const pending = runSandboxedPhase(ctx);
    await vi.advanceTimersByTimeAsync(getToolTimeout("bash") + 1_000);
    await expect(pending, "must not throw 'side-effect journal claim lost'").resolves.not.toThrow();

    const text = String(ctx.result?.content ?? "");
    expect(text).toMatch(/exceeded its \d+ms timeout/);
    expect(text).not.toMatch(/inside the harness|claim lost/i);

    // Safety is unchanged: the cut-off call is ambiguous and will not replay.
    const dir = join(dataDir, "operations", op, "side-effects");
    const entries = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    expect(entries.map((e) => e.state)).toEqual(["ambiguous"]);
  });
});

describe("the hang-catcher never beats the tool's own deadline", () => {
  it("sits above bash's own 120s default", () => {
    expect(getToolTimeout("bash")).toBeGreaterThan(120_000);
  });

  it("extends past a caller-set timeout longer than the default", () => {
    expect(backstopMs(130_000, { timeout: 300_000 })).toBeGreaterThan(300_000);
  });

  it("leaves the default alone when the caller sets nothing, or something shorter", () => {
    expect(backstopMs(130_000, {})).toBe(130_000);
    expect(backstopMs(130_000, { timeout: 5_000 })).toBe(130_000);
    expect(backstopMs(10_000, {})).toBe(10_000);
  });

  it("keeps unbounded tools unbounded", () => {
    expect(backstopMs(0, { timeout: 300_000 })).toBe(0);
  });
});

describe("backstopMs never lengthens a short deadline the caller did not ask to extend", () => {
  // The first cut returned own+margin whenever it beat `configured`, so with no
  // caller timeout (own = 0) a 50ms hang-catcher silently became 10s.
  it("returns the configured deadline exactly when the call sets no timeout", () => {
    expect(backstopMs(50, {})).toBe(50);
    expect(backstopMs(9_999, { timeout: 0 })).toBe(9_999);
  });
});
