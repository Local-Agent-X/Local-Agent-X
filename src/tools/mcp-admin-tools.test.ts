// mcp_add_server starts a program the agent chose. A vault secret named in
// its env, args or command goes to that program, so the call is put to the
// user under every profile, naming each secret and the command, and refused
// when nobody can be asked. A server that names no secret keeps its risk tier
// alone (no card on Power or Autonomous).
// The approval tests send the call through the live policy phase, not the
// gate directly: a gate the dispatcher never calls passes its own unit tests
// while the card it promises never appears.
import { afterEach, describe, expect, it } from "vitest";
import { createMcpAdminTools, mcpSecretUseGate } from "./mcp-admin-tools.js";
import { enforcePolicyPhase } from "../tool-execution/enforce-policy.js";
import { requireApprovalPhase } from "../tool-execution/require-approval.js";
import { getApprovalManager } from "../approval-manager.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { createContext, type CallContext, type PhaseOutcome, type ToolCallContext } from "../tool-execution/context.js";
import type { SecurityLayer } from "../security/index.js";
import type { ServerEvent } from "../types.js";

const GITHUB = {
  name: "github",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:GITHUB_TOKEN}" },
  executionMode: "sandboxed",
};
const PUPPETEER = { name: "puppeteer", command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"], env: { HEADLESS: "1" }, executionMode: "sandboxed" };

const cleanup: Array<() => void> = [];
afterEach(() => { for (const undo of cleanup.splice(0)) undo(); });

function session(profile: "Power" | "Autonomous"): string {
  const s = `mcp-secret-${profile}-${process.hrtime.bigint().toString(36)}`;
  setSessionProfile(s, profile);
  cleanup.push(() => clearSessionProfile(s));
  return s;
}

function gateCtx(args: Record<string, unknown>, name = "mcp_add_server"): Pick<ToolCallContext, "tc" | "args" | "policyApprovalReason"> {
  return { tc: { id: `tc-${name}`, name, arguments: JSON.stringify(args) }, args };
}

/** The call as a dispatcher builds it, judged by the policy phase and then the approval phase. */
async function dispatch(args: Record<string, unknown>, opts: { sessionId: string; callContext?: CallContext; onEvent?: (e: ServerEvent) => void }): Promise<{ c: ToolCallContext; approval: PhaseOutcome }> {
  const tool = createMcpAdminTools()[0];
  const c = createContext({
    tc: { id: `tc-mcp-${Math.random().toString(36).slice(2)}`, name: tool.name, arguments: JSON.stringify(args) },
    toolMap: new Map([[tool.name, tool]]),
    security: { evaluate: () => ({ allowed: true, reason: "" }) } as unknown as SecurityLayer,
    sessionId: opts.sessionId,
    callContext: opts.callContext ?? "local",
    onEvent: opts.onEvent,
  });
  c.args = { ...args };
  expect((await enforcePolicyPhase(c)).kind).toBe("continue");
  return { c, approval: await requireApprovalPhase(c) };
}

function reasonFor(args: Record<string, unknown>, name?: string): string | undefined {
  const c = gateCtx(args, name);
  mcpSecretUseGate(c);
  return c.policyApprovalReason;
}

describe("the reason an mcp_add_server call is put to the user", () => {
  it("names the secret, the server and the command it goes to", () => {
    expect(reasonFor(GITHUB)).toBe(
      'This mcp_add_server call gives the vault secret GITHUB_TOKEN to MCP server "github", a program the agent chose: '
      + "`npx -y @modelcontextprotocol/server-github`. Nothing checks where that program sends it. "
      + "Approve it only if you asked to connect this server with that secret.",
    );
  });

  it("names every secret, wherever the call references it, whether the vault holds it yet or not", () => {
    const reason = reasonFor({
      name: "db",
      command: "${secret:DB_LAUNCHER}",
      args: ["--url", "${secret:POSTGRES_URL}"],
      env: { TOKEN: "Bearer ${secret:API_TOKEN}", SAME: "${secret:API_TOKEN}" },
      executionMode: "sandboxed",
    });
    expect(reason).toContain("gives the vault secrets API_TOKEN, DB_LAUNCHER, POSTGRES_URL to MCP server \"db\"");
    expect(reason).toContain("`${secret:DB_LAUNCHER} --url ${secret:POSTGRES_URL}`");
    expect(reason).toContain("sends them");
  });

  it("asks nothing of a server that references no secret, a call the tool refuses, or another tool", () => {
    expect(reasonFor(PUPPETEER)).toBeUndefined();
    expect(reasonFor({ ...GITHUB, executionMode: "trusted" })).toBeUndefined();
    expect(reasonFor({ ...GITHUB, name: "bad name" })).toBeUndefined();
    expect(reasonFor({ command: "x", env: { T: "${secret:T}" } }, "bash")).toBeUndefined();
  });

  it("adds to another gate's reason once, even when judged twice", () => {
    const c = gateCtx(GITHUB);
    c.policyApprovalReason = "an earlier reason";
    mcpSecretUseGate(c);
    mcpSecretUseGate(c);
    expect(c.policyApprovalReason?.split("GITHUB_TOKEN")).toHaveLength(2);
    expect(c.policyApprovalReason).toMatch(/^an earlier reason; This mcp_add_server call gives/);
  });
});

describe("approval of an mcp_add_server call that hands over a secret", () => {
  it.each(["Power", "Autonomous"] as const)("shows a card naming the secret and command on %s", async (profile) => {
    const cards: Array<Extract<ServerEvent, { type: "approval_requested" }>> = [];
    const { approval } = await dispatch(GITHUB, {
      sessionId: session(profile),
      onEvent: (e) => {
        if (e.type !== "approval_requested") return;
        cards.push(e);
        getApprovalManager().resolveApproval(e.approvalId, true);
      },
    });
    expect(approval.kind).toBe("continue");
    expect(cards).toHaveLength(1);
    expect(cards[0].context).toContain("GITHUB_TOKEN");
    expect(cards[0].context).toContain("`npx -y @modelcontextprotocol/server-github`");
  });

  it("does not run when the user declines the card", async () => {
    const { c, approval } = await dispatch(GITHUB, {
      sessionId: session("Autonomous"),
      onEvent: (e) => { if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, false); },
    });
    expect(approval.kind).toBe("halt");
    expect(c.allowed).toBe(false);
  });

  it("is refused in an unattended run, under every profile", async () => {
    const { c, approval } = await dispatch(GITHUB, { sessionId: session("Autonomous"), callContext: "cron" });
    expect(approval.kind).toBe("halt");
    expect(c.result?.status).toBe("blocked");
    expect(String(c.result?.content)).toMatch(/^BLOCKED \(unattended\): mcp_add_server needs human approval because .*GITHUB_TOKEN/);
  });

  it("runs with no card on Power or Autonomous when it references no secret", async () => {
    for (const profile of ["Power", "Autonomous"] as const) {
      const events: ServerEvent[] = [];
      const { approval } = await dispatch(PUPPETEER, { sessionId: session(profile), onEvent: (e) => events.push(e) });
      expect(approval.kind).toBe("continue");
      expect(events.filter((e) => e.type === "approval_requested")).toEqual([]);
    }
  });
});
