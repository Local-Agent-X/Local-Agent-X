// Handing a vault secret to a command follows the profile's `secrets` rule:
// Safe refuses, Normal/Power ask once per program and secret, Autonomous runs.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallContext } from "./context.js";

const requests: Array<{ toolName: string; args: unknown; context: string; alwaysAsk?: boolean }> = [];
const state: { rule: string; answer: { approved: boolean; reason?: string } } = { rule: "ask", answer: { approved: true } };
vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({ requestApprovalDetailed: async (o: (typeof requests)[number]) => { requests.push(o); return state.answer; } }),
  getRiskDecision: (risk: string) => (risk === "secrets" ? state.rule : "allow"),
  decisionDenies: (d: string) => d === "deny",
  decisionRequiresPrompt: (d: string) => d === "ask",
}));

const { secretEnvGate } = await import("./secret-env-approval.js");
const { computeArgsFingerprint } = await import("../approval-decision.js");

const ctx = (over: Partial<ToolCallContext> = {}): ToolCallContext => ({
  tc: { id: "c1", name: "bash", arguments: "{}" },
  args: { command: "npx supabase functions deploy food-search", secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" } },
  callContext: "local",
  sessionId: "s",
  onEvent: () => {},
  ...over,
}) as unknown as ToolCallContext;

beforeEach(() => { requests.length = 0; state.rule = "ask"; state.answer = { approved: true }; });

describe("secretEnvGate", () => {
  it("ask (Normal, Power): one card naming the program and the secret, never the value, and 'always allow' is offered", async () => {
    expect(await secretEnvGate(ctx())).toEqual({ kind: "continue" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ toolName: "use_secret", args: { program: "npx supabase", secrets: ["SUPABASE_TOKEN"] } });
    expect(requests[0].context).toContain("Let `npx supabase` use SUPABASE_TOKEN?");
    expect(requests[0].alwaysAsk).toBeUndefined();
  });

  it("a no stops the call", async () => {
    state.answer = { approved: false, reason: "declined" };
    expect(await secretEnvGate(ctx())).toEqual({ kind: "denied", reason: "declined" });
  });

  it.each(["allow", "allow-with-rollback"])("%s (Autonomous): runs without a card", async (rule) => {
    state.rule = rule;
    expect(await secretEnvGate(ctx())).toEqual({ kind: "continue" });
    expect(requests).toHaveLength(0);
  });

  it("deny (Safe) and an unattended ask are refused, with no card", async () => {
    state.rule = "deny";
    expect((await secretEnvGate(ctx())).kind).toBe("blocked");
    state.rule = "ask";
    expect((await secretEnvGate(ctx({ callContext: "cron" } as Partial<ToolCallContext>))).kind).toBe("blocked");
    expect(requests).toHaveLength(0);
  });

  it("a call without secret_env, or another tool, is not its business", async () => {
    expect(await secretEnvGate(ctx({ args: { command: "ls" } }))).toEqual({ kind: "continue" });
    expect(await secretEnvGate(ctx({ tc: { id: "c2", name: "read", arguments: "{}" } }))).toEqual({ kind: "continue" });
    expect(requests).toHaveLength(0);
  });

  it("an 'always allow' covers this program with these secrets only", () => {
    const key = (program: string, secrets: string[]) => computeArgsFingerprint("use_secret", { program, secrets });
    expect(key("npx supabase", ["B", "A"])).toBe(key("npx supabase", ["A", "B"]));
    expect(key("npx supabase", ["A"])).not.toBe(key("gh", ["A"]));
    expect(key("npx supabase", ["A"])).not.toBe(key("npx supabase", ["A", "B"]));
  });
});
