import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the on-disk usage log under a temp LAX dir so the test never touches
// ~/.lax. cost-tracker binds USAGE_FILE = join(getLaxDir(), …) at import time,
// so LAX_DATA_DIR MUST be set before the dynamic import below (top-level await
// runs at file eval, before any beforeAll hook).
const prevLaxDir = process.env.LAX_DATA_DIR;
const tmp = mkdtempSync(join(tmpdir(), "lax-spend-cap-"));
process.env.LAX_DATA_DIR = tmp;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(tmp, { recursive: true, force: true });
});

const { trackUsage, isBillableSource, noteResolvedAuthSource, noteResolvedModel } = await import("../../cost-tracker.js");
const { setRuntimeConfig, loadConfig } = await import("../../config.js");
const { makeSpendCapPack } = await import("./spend-cap-pack.js");

const SESSION = "sess-cap";
const CALL = { id: "c1", name: "bash", args: {} };
const CTX = { sessionId: SESSION, callContext: "local" as const };

const evalCap = () => Promise.resolve(makeSpendCapPack().evaluate(CALL, CTX));

function setBudgets(daily: number, session: number, modelDailyBudgetsUsd: Record<string, number> = {}): void {
  setRuntimeConfig({ ...loadConfig(), dailyBudgetUsd: daily, sessionBudgetUsd: session, modelDailyBudgetsUsd });
}

// $6 of opus output tokens (25/M output) — used to exceed a $5 cap.
function spend6Usd(authSource: "env" | "oauth"): void {
  trackUsage(SESSION, "claude-opus-4-8", "anthropic", 0, 240_000, undefined, authSource);
}

beforeEach(() => {
  const usageFile = join(tmp, "usage-log.json");
  if (existsSync(usageFile)) unlinkSync(usageFile);
});

describe("isBillableSource", () => {
  it("bills real API keys but not subscriptions or local", () => {
    expect(isBillableSource("env")).toBe(true);
    expect(isBillableSource("secrets-store")).toBe(true);
    expect(isBillableSource("config")).toBe(true);
    expect(isBillableSource(undefined)).toBe(true); // untagged → safe default: billable
    expect(isBillableSource("oauth")).toBe(false);
    expect(isBillableSource("sentinel")).toBe(false);
  });
});

describe("spend-cap pack — auth-aware", () => {
  it("allows when no budgets are configured", async () => {
    setBudgets(0, 0);
    noteResolvedAuthSource("env");
    spend6Usd("env");
    expect((await evalCap()).allowed).toBe(true);
  });

  it("denies an API-key user over the daily cap", async () => {
    setBudgets(5, 0);
    noteResolvedAuthSource("env");
    spend6Usd("env");
    const d = await evalCap();
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("spend-cap.daily");
  });

  it("NEVER blocks a subscription (oauth) user, even past the shadow budget", async () => {
    setBudgets(5, 0);
    noteResolvedAuthSource("oauth"); // last resolved credential was a subscription
    spend6Usd("oauth");
    expect((await evalCap()).allowed).toBe(true);
  });

  it("excludes subscription spend from the bill even while in API-key mode", async () => {
    // Process mode is api-key, but the $6 record itself is subscription-sourced
    // → billable total is $0 → under the $5 cap → allowed. Proves the per-record
    // filter, not just the process-mode short-circuit.
    setBudgets(5, 0);
    noteResolvedAuthSource("env");
    spend6Usd("oauth");
    expect((await evalCap()).allowed).toBe(true);
  });

  it("denies an API-key user over the per-session cap", async () => {
    setBudgets(0, 5);
    noteResolvedAuthSource("env");
    spend6Usd("env");
    const d = await evalCap();
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("spend-cap.session");
  });
});

describe("spend-cap pack — per-model daily limit", () => {
  // grok-4.3 @ $1.25/M input: 3M input = $3.75, over a $3 cap.
  function spendOnGrok(authSource: "env" | "oauth"): void {
    trackUsage(SESSION, "grok-4.3", "xai", 3_000_000, 0, undefined, authSource);
  }

  it("blocks a model once its real spend passes its per-model cap", async () => {
    setBudgets(0, 0, { "grok-4.3": 3 });
    noteResolvedAuthSource("env");
    noteResolvedModel("grok-4.3");
    spendOnGrok("env");
    const d = await evalCap();
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("spend-cap.model");
  });

  it("does not affect a different model that has no cap", async () => {
    setBudgets(0, 0, { "grok-4.3": 3 });
    noteResolvedAuthSource("env");
    noteResolvedModel("claude-opus-4-8"); // not in the budget map
    spendOnGrok("env");
    expect((await evalCap()).allowed).toBe(true);
  });

  it("never caps a subscription model — its billable spend is $0", async () => {
    setBudgets(0, 0, { "grok-4.3": 3 });
    noteResolvedAuthSource("oauth"); // subscription → short-circuits before any cap
    noteResolvedModel("grok-4.3");
    spendOnGrok("oauth");
    expect((await evalCap()).allowed).toBe(true);
  });

  it("allows a capped model still under its limit", async () => {
    setBudgets(0, 0, { "grok-4.3": 100 });
    noteResolvedAuthSource("env");
    noteResolvedModel("grok-4.3");
    spendOnGrok("env"); // $3.75, under $100
    expect((await evalCap()).allowed).toBe(true);
  });
});
