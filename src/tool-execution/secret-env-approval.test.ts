// Handing a vault secret to a command follows the profile's `secrets` rule:
// Safe refuses, Normal/Power ask once per program and secret, Autonomous runs.
// The same for every tool that takes secret_env: bash and the background
// process tools.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallContext } from "./context.js";

const requests: Array<{ toolName: string; args: unknown; context: string; alwaysAsk?: boolean }> = [];
const state: { rule: string; answer: { approved: boolean; reason?: string } } = { rule: "ask", answer: { approved: true } };
const { CallGrants } = await import("../approval-call-grants.js");
const callGrants = new CallGrants();
vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({ callGrants, requestApprovalDetailed: async (o: (typeof requests)[number]) => { requests.push(o); return state.answer; } }),
  getRiskDecision: (risk: string) => (risk === "secrets" ? state.rule : "allow"),
  decisionDenies: (d: string) => d === "deny",
  decisionRequiresPrompt: (d: string) => d === "ask",
}));
// Paid API keys for images and video are off, as on a fresh install.
vi.mock("../settings.js", async (orig) => ({ ...(await orig<typeof import("../settings.js")>()), loadSettings: () => ({}) }));

const { secretEnvGate } = await import("./secret-env-approval.js");
const { computeArgsFingerprint } = await import("../approval-decision.js");
const { SESSIONS } = await import("../tools/process-session.js");
type TrackedSession = Parameters<typeof SESSIONS.set>[1];

const ctxFor = (tool: string) => (over: Partial<ToolCallContext> = {}): ToolCallContext => ({
  tc: { id: "c1", name: tool, arguments: "{}" },
  args: { command: "npx supabase functions deploy food-search", secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" } },
  callContext: "local",
  sessionId: "s",
  onEvent: () => {},
  ...over,
}) as unknown as ToolCallContext;

beforeEach(() => { requests.length = 0; state.rule = "ask"; state.answer = { approved: true }; });

describe.each(["bash", "process_start", "process_restart"])("secretEnvGate on %s", (tool) => {
  const ctx = ctxFor(tool);

  it("ask (Normal, Power): one card naming the program and the secret, never the value, and 'always allow' is offered", async () => {
    expect(await secretEnvGate(ctx())).toEqual({ kind: "continue" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ toolName: "use_secret", args: { program: "npx supabase", secrets: ["SUPABASE_TOKEN"] } });
    expect(requests[0].context).toContain("Let `npx supabase` use SUPABASE_TOKEN?");
    expect(requests[0].alwaysAsk).toBeUndefined();
  });

  it("a command that works on the value says so on the card: its output goes to the inbox, not the model", async () => {
    expect(await secretEnvGate(ctx({ args: { command: "echo $SUPABASE_ACCESS_TOKEN | rev", secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" } } }))).toEqual({ kind: "continue" });
    expect(requests[0].context).toContain("Note: this command prints or writes out $SUPABASE_ACCESS_TOKEN, so its output will go to your inbox, not the model.");
    expect(requests[0].context).toContain("never to the model");
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

  it("the user's yes to this exact call, given from the inbox, answers the card in any run; deny still wins", async () => {
    const call = ctx({ callContext: "cron" } as Partial<ToolCallContext>);
    callGrants.grant("s", tool, call.args);
    state.rule = "deny";
    expect((await secretEnvGate(call)).kind).toBe("blocked");
    state.rule = "ask";
    expect(await secretEnvGate(call)).toEqual({ kind: "continue" });
    expect(call.approvedByUser).toBe(true);
    expect(requests).toHaveLength(0);
    expect(callGrants.size()).toBe(0);
  });

  it("a call without secret_env is not its business", async () => {
    expect(await secretEnvGate(ctx({ args: { command: "ls" } }))).toEqual({ kind: "continue" });
    expect(requests).toHaveLength(0);
  });

  it("a media provider's API key is refused before any card while paid API keys for images and video are off", async () => {
    for (const rule of ["ask", "allow"]) {
      state.rule = rule;
      const gate = await secretEnvGate(ctx({ args: { command: "curl https://api.openai.com/v1/images/generations", secret_env: { OPENAI_API_KEY: "OPENAI_API_KEY" } } }));
      expect(gate.kind).toBe("blocked");
      expect((gate as { result: { content: string } }).result.content).toContain("Paid API image generation is off");
    }
    expect(requests).toHaveLength(0);
  });
});

describe("secretEnvGate", () => {
  it("a tool that does not take secret_env is not its business", async () => {
    expect(await secretEnvGate(ctxFor("read")())).toEqual({ kind: "continue" });
    expect(await secretEnvGate(ctxFor("http_request")())).toEqual({ kind: "continue" });
    expect(requests).toHaveLength(0);
  });

  it("a process_restart naming no command asks about the tracked session's program", async () => {
    SESSIONS.set("px-tracked-secret", { sessionId: "px-tracked-secret", command: "gh run watch" } as TrackedSession);
    try {
      const ctx = ctxFor("process_restart")({ args: { session_id: "px-tracked-secret", secret_env: { GH_TOKEN: "GITHUB_TOKEN" } } });
      expect(await secretEnvGate(ctx)).toEqual({ kind: "continue" });
      expect(requests[0]).toMatchObject({ args: { program: "gh", secrets: ["GITHUB_TOKEN"] } });
    } finally {
      SESSIONS.delete("px-tracked-secret");
    }
  });

  it("an 'always allow' covers this program with these secrets only", () => {
    const key = (program: string, secrets: string[]) => computeArgsFingerprint("use_secret", { program, secrets });
    expect(key("npx supabase", ["B", "A"])).toBe(key("npx supabase", ["A", "B"]));
    expect(key("npx supabase", ["A"])).not.toBe(key("gh", ["A"]));
    expect(key("npx supabase", ["A"])).not.toBe(key("npx supabase", ["A", "B"]));
  });
});
