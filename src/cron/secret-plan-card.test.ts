// The chat puts a key on a scheduled job's plan only on the user's yes to a
// card worded for that job, keeps the yes on the job (never in the vault), and
// from an unattended run adds nothing: a job cannot grant itself keys.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { cards } = vi.hoisted(() => ({
  cards: { answerFor: ((_name: string) => true) as (name: string) => boolean, asked: [] as Array<{ toolName: string; context: string; args: Record<string, unknown> }> },
}));
vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({
    requestApprovalDetailed: async (opts: { toolName: string; context: string; args: Record<string, unknown> }) => {
      cards.asked.push(opts);
      return cards.answerFor(String(opts.args.name)) ? { approved: true } : { approved: false, reason: "declined" };
    },
  }),
}));
const preBlessed = vi.hoisted(() => new Set<string>());
vi.mock("../ops/pre-bless.js", () => ({ getActivePreBlessedSecrets: () => preBlessed }));

import { CronService } from "./cron-service.js";
import { createCronTools } from "./tools.js";
import { SecretsStore, setSecretsStoreSingleton } from "../secrets.js";
import type { ToolResult } from "../types.js";

let dataDir = "";
let cron: CronService;
let store: SecretsStore;
const chat = { _onEvent: () => undefined, _toolCallId: "tc-1", _callContext: "local", _sessionId: "chat-1" };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cron-plan-card-"));
  cron = new CronService(dataDir);
  cron.updateSettings({ enabled: false });
  store = new SecretsStore(dataDir);
  store.set("SUPABASE_MGMT_TOKEN", "sbp_x");
  store.set("SUPABASE_FULL_ACCOUNT_TOKEN", "sbp_y");
  store.set("GITHUB_TOKEN", "ghp_x", { url: "https://github.com/login" });
  setSecretsStoreSingleton(store);
  cards.answerFor = () => true;
  cards.asked.length = 0;
  preBlessed.clear();
});
afterEach(() => {
  cron.stop();
  setSecretsStoreSingleton(null as unknown as SecretsStore);
  rmSync(dataDir, { recursive: true, force: true });
});

function run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const def = createCronTools(cron).find((t) => t.name === tool);
  if (!def) throw new Error(`no tool ${tool}`);
  return def.execute(args);
}

const MGMT = { name: "SUPABASE_MGMT_TOKEN", destination: "https://api.supabase.com" };
const FULL = { name: "SUPABASE_FULL_ACCOUNT_TOKEN", destination: "https://kybhkldvgdezjrwnmmyr.supabase.co" };

describe("mission_schedule_create with secrets, in the chat", () => {
  it("asks once per pair, worded for the job; a yes goes on the job's plan, a no stays off and the result says so", async () => {
    cards.answerFor = (name) => name === MGMT.name;
    const r = await run("mission_schedule_create", { name: "nightly", schedule: "0 3 * * *", prompt: "check projects", secrets: [MGMT, FULL], ...chat });
    expect(cards.asked.map((c) => c.args.name)).toEqual([MGMT.name, FULL.name]);
    expect(cards.asked[0].toolName).toBe("mission_schedule_create");
    expect(cards.asked[0].context).toContain(`Let scheduled job "nightly" send SUPABASE_MGMT_TOKEN to https://api.supabase.com when it runs`);
    expect(cards.asked[0].context).not.toContain("sbp_x");
    const job = cron.list()[0];
    expect(job.secretPlan).toEqual([MGMT]);
    expect(r.content).toContain("Keys added to its plan");
    expect(r.content).toContain(`Not added: ${FULL.name} at ${FULL.destination}: the user said no`);
    // Kept on the job, never in the vault: no other session gains the pair.
    expect(store.isDestinationApproved(MGMT.name, MGMT.destination)).toBe(false);
  });

  // The plan is permanent, so only the user's lasting yes skips the card.
  it("a pair on the key's own saved site (or under it) goes on the plan without a card", async () => {
    await run("mission_schedule_create", { name: "gh", schedule: "1h", prompt: "p", secrets: [{ name: "GITHUB_TOKEN", destination: "api.github.com" }], ...chat });
    expect(store.destinationDecision("GITHUB_TOKEN", "https://api.github.com", { sessionId: "chat-1" })).toBe("origin");
    expect(cards.asked).toHaveLength(0);
    expect(cron.list()[0].secretPlan).toEqual([{ name: "GITHUB_TOKEN", destination: "https://api.github.com" }]);
  });

  it("a pair the user approved earlier goes on the plan without a card", async () => {
    store.approveDestination(MGMT.name, MGMT.destination);
    await run("mission_schedule_create", { name: "n", schedule: "1h", prompt: "p", secrets: [MGMT], ...chat });
    expect(cards.asked).toHaveLength(0);
    expect(cron.list()[0].secretPlan).toEqual([MGMT]);
  });

  it("a key this chat captured is a temporary allowance: it still gets a card, and a no keeps it off", async () => {
    store.set("CAPTURED_KEY", "v", { origin: "https://app.example.com", createdBySession: "chat-1" });
    const pair = { name: "CAPTURED_KEY", destination: "https://api.example.com" };
    expect(store.destinationDecision(pair.name, pair.destination, { sessionId: "chat-1" })).toBe("session");
    cards.answerFor = () => false;
    await run("mission_schedule_create", { name: "n", schedule: "1h", prompt: "p", secrets: [pair], ...chat });
    expect(cards.asked.map((c) => c.args.name)).toEqual(["CAPTURED_KEY"]);
    expect(cron.list()[0].secretPlan).toBeUndefined();
  });

  it("a pre-blessed key is a temporary allowance: it still gets a card", async () => {
    preBlessed.add(MGMT.name);
    expect(store.destinationDecision(MGMT.name, MGMT.destination, { sessionId: "chat-1" })).toBe("pre_bless");
    await run("mission_schedule_create", { name: "n", schedule: "1h", prompt: "p", secrets: [MGMT], ...chat });
    expect(cards.asked.map((c) => c.args.name)).toEqual([MGMT.name]);
    expect(cron.list()[0].secretPlan).toEqual([MGMT]);
  });

  it("a key the vault does not hold, or no site, is not added and is named", async () => {
    const r = await run("mission_schedule_create", { name: "n", schedule: "1h", prompt: "p", secrets: [{ name: "NOPE", destination: "https://x.example" }, { name: "GITHUB_TOKEN", destination: "" }], ...chat });
    expect(cards.asked).toHaveLength(0);
    expect(cron.list()[0].secretPlan).toBeUndefined();
    expect(r.content).toContain("there is no saved key named NOPE");
    expect(r.content).toMatch(/is not a site \(for GITHUB_TOKEN\)/);
  });
});

describe("a job cannot grant itself keys", () => {
  it("from an unattended run nothing is added, no card is raised, and the result says where the user adds them", async () => {
    for (const context of ["cron", "delegated", "api"]) {
      const r = await run("mission_schedule_create", { name: `job-${context}`, schedule: "1h", prompt: "p", secrets: [MGMT], ...chat, _callContext: context });
      expect(r.content, context).toContain("No keys were added to its plan");
      expect(r.content, context).toContain("Missions page");
      expect(cron.list().find((j) => j.name === `job-${context}`)?.secretPlan, context).toBeUndefined();
    }
    expect(cards.asked).toHaveLength(0);
  });
});

describe("mission_schedule_update with secrets", () => {
  it("adds a pair only on the card's yes, and keeps the plan it had", async () => {
    const job = cron.create("n", "1h", "p", false, { secretPlan: [MGMT] });
    cards.answerFor = () => false;
    const no = await run("mission_schedule_update", { id: job.id, secrets: [FULL], ...chat });
    expect(no.content).toContain("the user said no");
    expect(cron.get(job.id)?.secretPlan).toEqual([MGMT]);
    cards.answerFor = () => true;
    const yes = await run("mission_schedule_update", { id: job.id, secrets: [FULL, MGMT], ...chat });
    expect(cards.asked.filter((c) => c.args.name === MGMT.name)).toHaveLength(0);
    expect(yes.content).toContain(`Updated mission "n".`);
    expect(cron.get(job.id)?.secretPlan).toEqual([MGMT, FULL]);
  });

  it("from an unattended run adds nothing", async () => {
    const job = cron.create("n", "1h", "p");
    const r = await run("mission_schedule_update", { id: job.id, secrets: [MGMT], ...chat, _callContext: "delegated" });
    expect(r.content).toContain("No keys were added");
    expect(cron.get(job.id)?.secretPlan).toBeUndefined();
    expect(cards.asked).toHaveLength(0);
  });
});
