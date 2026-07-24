import { afterEach, describe, expect, it, vi } from "vitest";

// The lease duration default is resolved from LAX_LEASE_DURATION_MS ONCE at
// module load, so each case re-imports lease.ts under a fresh module registry
// with the env var set beforehand. resetLeaseConfig() must reset to the
// env-resolved default (not a hardcoded 30s), which getLeaseConfig() reports.
async function loadDefaultLeaseDurationMs(raw: string | undefined): Promise<number> {
  vi.resetModules();
  if (raw === undefined) delete process.env.LAX_LEASE_DURATION_MS;
  else process.env.LAX_LEASE_DURATION_MS = raw;
  const mod = await import("../src/canonical-loop/lease.js");
  // Prove reset lands on the env-resolved default, not a hardcoded value.
  mod.setLeaseConfig({ leaseDurationMs: 12_345 });
  mod.resetLeaseConfig();
  return mod.getLeaseConfig().leaseDurationMs;
}

describe("lease duration default from LAX_LEASE_DURATION_MS", () => {
  const original = process.env.LAX_LEASE_DURATION_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.LAX_LEASE_DURATION_MS;
    else process.env.LAX_LEASE_DURATION_MS = original;
    vi.resetModules();
  });

  it("defaults to 60s when the env var is unset", async () => {
    expect(await loadDefaultLeaseDurationMs(undefined)).toBe(60_000);
  });

  it("honors a valid in-range override", async () => {
    expect(await loadDefaultLeaseDurationMs("120000")).toBe(120_000);
  });

  it("honors the inclusive range boundaries", async () => {
    expect(await loadDefaultLeaseDurationMs("30000")).toBe(30_000);
    expect(await loadDefaultLeaseDurationMs("600000")).toBe(600_000);
  });

  it("falls back to 60s for a value below the floor", async () => {
    expect(await loadDefaultLeaseDurationMs("29999")).toBe(60_000);
  });

  it("falls back to 60s for a value above the ceiling", async () => {
    expect(await loadDefaultLeaseDurationMs("600001")).toBe(60_000);
  });

  it("falls back to 60s for a non-numeric or non-integer value", async () => {
    expect(await loadDefaultLeaseDurationMs("not-a-number")).toBe(60_000);
    expect(await loadDefaultLeaseDurationMs("60000.5")).toBe(60_000);
    expect(await loadDefaultLeaseDurationMs("")).toBe(60_000);
  });
});
