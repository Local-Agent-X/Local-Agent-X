// Grok's and GPT's cached tokens sit inside their input count; the ledger
// priced every one at the full input rate (2026-11-27). They now go to the
// ledger as cache reads, beside the input, as Anthropic's do.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ usage: {} as Record<string, unknown>, trackUsage: vi.fn() }));
vi.mock("./op-usage.js", () => ({ aggregateOpUsage: () => mocks.usage }));
vi.mock("../ops/op-store.js", () => ({
  readOp: () => ({ canonical: { sessionId: "s" }, contextPack: { routing: { preferredProvider: "xai", authSource: "oauth" } } }),
}));
vi.mock("../cost-tracker.js", () => ({ trackUsage: mocks.trackUsage }));

import { recordCostEvent } from "./cost-recording.js";

const finished = { type: "state_changed", opId: "op-1", body: { to: "succeeded" } } as never;
const base = { usageOutputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0, promptCachedTokens: 0, model: "grok-4.7", sawAnyUsage: true, sawAnyCache: false };

beforeEach(() => { mocks.trackUsage.mockClear(); });

describe("recordCostEvent", () => {
  it("records a Grok op's cached tokens as cache reads, out of the input", () => {
    mocks.usage = { ...base, usageInputTokens: 100_000, promptCachedTokens: 60_000, sawAnyCache: true };
    recordCostEvent(finished);
    expect(mocks.trackUsage).toHaveBeenCalledWith("s", "grok-4.7", "xai", 40_000, 500, undefined, "oauth", { readTokens: 60_000, writeTokens: 0 });
  });

  it("leaves Anthropic's cache reads beside the input as they were", () => {
    mocks.usage = { ...base, model: "claude-sonnet-4-6", usageInputTokens: 2_000, cacheReadTokens: 40_000, cacheCreateTokens: 300, sawAnyCache: true };
    recordCostEvent(finished);
    expect(mocks.trackUsage).toHaveBeenCalledWith("s", "claude-sonnet-4-6", "xai", 2_000, 500, undefined, "oauth", { readTokens: 40_000, writeTokens: 300 });
  });

  it("passes no cache figures for a transport that reports none", () => {
    mocks.usage = { ...base, usageInputTokens: 10_000 };
    recordCostEvent(finished);
    expect(mocks.trackUsage).toHaveBeenCalledWith("s", "grok-4.7", "xai", 10_000, 500, undefined, "oauth", undefined);
  });
});
