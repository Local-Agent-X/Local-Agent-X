// A scheduled job's key plan: the pairs the user named for THAT job, read by
// the vault's ladder for that job's run sessions and every helper registered
// under them, and for no other session. Off the plan, an unattended run still
// gets the needs-you refusal its pipeline parks in the inbox.
//
// The incident (2026-10-21): a job scheduled from a chat picked a key it was
// never given and sent another key to a new host at 3 a.m.; both parked, and
// the job finished "partial". A plan covers what the user named; the rest asks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { asked } = vi.hoisted(() => ({ asked: [] as unknown[] }));
vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({ requestApprovalDetailed: async (opts: unknown) => { asked.push(opts); return { approved: true }; } }),
}));
vi.mock("../ops/pre-bless.js", () => ({ getActivePreBlessedSecrets: () => new Set<string>() }));

import { SecretsStore } from "../secrets.js";
import { gateSecretDestinations } from "../secret-destination-gate.js";
import { _resetSessionOwnerRegistry, clearSessionOwner, registerChildSessionOwner, registerSessionOwner } from "../browser/session-owner-registry.js";
import { cronSessionId } from "./cron-session.js";
import {
  jobOfSession, parseSecretPlan, parseSecretPlanPair, plannedForSession, samePlan, secretPlanPromptBlock, setJobSecretPlanSource,
  type SecretPlanPair,
} from "./job-secret-plan.js";

const MGMT = { name: "SUPABASE_MGMT_TOKEN", destination: "https://api.supabase.com" };
const plans = new Map<string, SecretPlanPair[]>();

let dir: string;
let store: SecretsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-job-plan-"));
  store = new SecretsStore(dir);
  store.set("SUPABASE_MGMT_TOKEN", "sbp_x");
  store.set("SUPABASE_FULL_ACCOUNT_TOKEN", "sbp_y");
  plans.clear();
  setJobSecretPlanSource((jobId) => plans.get(jobId));
  asked.length = 0;
});
afterEach(() => {
  setJobSecretPlanSource(() => undefined);
  _resetSessionOwnerRegistry();
  rmSync(dir, { recursive: true, force: true });
});

describe("parsing a plan", () => {
  it("normalizes a name and a site, and takes a bare host as https", () => {
    expect(parseSecretPlanPair({ name: "supabase_mgmt_token", destination: "api.supabase.com/v1/projects" }))
      .toEqual({ name: "SUPABASE_MGMT_TOKEN", destination: "https://api.supabase.com" });
    expect(parseSecretPlanPair({ name: "K", destination: "https://API.example.com:443/x" })).toEqual({ name: "K", destination: "https://api.example.com" });
  });

  it("says why an entry is not a pair", () => {
    expect(parseSecretPlanPair({ name: "has space", destination: "https://a.example" })).toMatch(/not a saved key's name/);
    expect(parseSecretPlanPair({ name: "K", destination: "" })).toMatch(/not a site/);
    expect(parseSecretPlan("x")).toEqual({ error: expect.stringMatching(/must be a list/) });
    expect(parseSecretPlan([{ name: "K" }])).toEqual({ error: expect.stringMatching(/secretPlan: .*not a site/) });
  });

  it("drops repeats, and compares plans in any order", () => {
    const parsed = parseSecretPlan([MGMT, { ...MGMT, destination: "api.supabase.com" }]);
    expect(parsed).toEqual({ plan: [MGMT] });
    const other = { name: "B", destination: "https://b.example" };
    expect(samePlan([MGMT, other], [other, MGMT])).toBe(true);
    expect(samePlan([MGMT], [other])).toBe(false);
    expect(samePlan(undefined, [])).toBe(true);
  });
});

describe("which sessions a plan covers", () => {
  it("the job's run, and the agents and workers it spawns, flattened to the run", () => {
    const run = cronSessionId("cron_abc", 1000);
    registerSessionOwner(run, { browserProfile: { kind: "job", jobId: "cron_abc" } });
    registerChildSessionOwner("agent-run-1", run, { agentId: "researcher" });
    registerChildSessionOwner("op-worker-1", "agent-run-1");
    expect(jobOfSession(run)).toBe("cron_abc");
    expect(jobOfSession("agent-run-1")).toBe("cron_abc");
    expect(jobOfSession("op-worker-1")).toBe("cron_abc");
    // A child outlives the run's own record (the runner clears it in finally,
    // then waits for the agents it spawned).
    clearSessionOwner(run);
    expect(jobOfSession("agent-run-1")).toBe("cron_abc");
    expect(jobOfSession("chat-1")).toBeUndefined();
    expect(jobOfSession(undefined)).toBeUndefined();
  });

  it("only the job's own plan, read live: a removed pair stops the next send", () => {
    plans.set("cron_abc", [MGMT]);
    const run = cronSessionId("cron_abc", 1000);
    expect(plannedForSession(run, MGMT.name, MGMT.destination)).toBe(true);
    expect(plannedForSession(cronSessionId("cron_other", 1000), MGMT.name, MGMT.destination)).toBe(false);
    expect(plannedForSession("chat-1", MGMT.name, MGMT.destination)).toBe(false);
    plans.set("cron_abc", []);
    expect(plannedForSession(run, MGMT.name, MGMT.destination)).toBe(false);
  });
});

// The seam: the plan (cron) ↔ the ladder (SecretsStore.destinationDecision) ↔
// the gate every emitter runs (secret-destination-gate.ts), in an unattended run.
describe("the ladder and the gate read the plan for the job's sessions", () => {
  const cronCall = { _onEvent: () => undefined, _toolCallId: "tc", _callContext: "cron" };
  const send = (sessionId: string, name: string, destination: string) =>
    gateSecretDestinations([{ name, destination, purpose: `Send ${name}` }], { store, sessionId, toolName: "http_request", call: cronCall });

  it("a planned pair goes without a card or an inbox item, and is never kept in the vault", async () => {
    plans.set("cron_abc", [MGMT]);
    const run = cronSessionId("cron_abc", 1000);
    registerChildSessionOwner("agent-run-1", run);
    expect(store.destinationDecision(MGMT.name, "https://api.supabase.com/v1/projects", { sessionId: run })).toBe("planned");
    expect(await send(run, MGMT.name, "https://api.supabase.com/v1/projects")).toEqual({ allowed: true });
    expect(await send("agent-run-1", MGMT.name, "https://api.supabase.com/v1/projects")).toEqual({ allowed: true });
    expect(asked).toHaveLength(0);
    expect(store.isDestinationApproved(MGMT.name, MGMT.destination)).toBe(false);
    // Not approved for anyone else: a chat, or another job.
    expect(store.destinationDecision(MGMT.name, MGMT.destination, { sessionId: "chat-1" })).toBe("ask");
    expect(store.destinationDecision(MGMT.name, MGMT.destination, { sessionId: cronSessionId("cron_other", 1) })).toBe("ask");
  });

  it("a key off the plan, or a planned key at another site, still waits for the user", async () => {
    plans.set("cron_abc", [MGMT]);
    const run = cronSessionId("cron_abc", 1000);
    const offPlan = await send(run, "SUPABASE_FULL_ACCOUNT_TOKEN", "https://kybhkldvgdezjrwnmmyr.supabase.co/rest/v1");
    expect(offPlan.allowed).toBe(false);
    if (offPlan.allowed) return;
    expect(String(offPlan.result.metadata?.needsUser)).toContain(`"SUPABASE_FULL_ACCOUNT_TOKEN" at https://kybhkldvgdezjrwnmmyr.supabase.co`);
    const elsewhere = await send(run, MGMT.name, "https://attacker.example");
    expect(elsewhere.allowed).toBe(false);
    if (elsewhere.allowed) return;
    expect(String(elsewhere.result.metadata?.needsUser)).toContain(`"SUPABASE_MGMT_TOKEN" at https://attacker.example`);
    expect(asked).toHaveLength(0);
  });
});

describe("the run's instructions", () => {
  it("name each planned key and its site, never a value", () => {
    const block = secretPlanPromptBlock([MGMT, { name: "GITHUB_TOKEN", destination: "https://api.github.com" }]);
    expect(block).toContain("- SUPABASE_MGMT_TOKEN at https://api.supabase.com");
    expect(block).toContain("- GITHUB_TOKEN at https://api.github.com");
    expect(block).toContain("Use these keys for these sites");
    expect(block).not.toContain("sbp_x");
    expect(secretPlanPromptBlock(undefined)).toBe("");
    expect(secretPlanPromptBlock([])).toBe("");
  });
});
