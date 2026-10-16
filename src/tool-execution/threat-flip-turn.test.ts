// The turn the threat engine turns a session restricted, the audit phase
// withholds the result of every outside call by the same rule the
// pre-dispatch pack refuses the next one with (threat-engine-pack.ts
// restrictedCall): the whole egress class, except the browser opening this
// app's own pages. It used to name http_request, web_fetch and browser, so on
// that turn an email_send or web_search result still reached the model.
import { describe, it, expect } from "vitest";
import { auditPhase } from "./audit-tool-call.js";
import type { ToolCallContext } from "./context.js";
import { CAPABILITY_CLASS_MEMBERS } from "../tool-registry.js";

const restrictedEngine = {
  evaluateToolResult: () => ({ blocked: false }),
  isRestricted: () => true,
  getRestrictionEvidence: () => ({ types: ["exfil_pattern"], sinks: [] }),
};

async function audited(tool: string, args: Record<string, unknown>): Promise<ToolCallContext> {
  const ctx = {
    tc: { id: `call_${tool}`, name: tool, arguments: JSON.stringify(args) },
    args,
    sessionId: "flip-turn-sess",
    callContext: "local",
    allowed: true,
    msgs: [],
    result: { content: "fetched", status: "ok" },
    threatEngine: restrictedEngine,
  } as unknown as ToolCallContext;
  await auditPhase(ctx);
  return ctx;
}

describe("the restricted flip turn withholds every outside call's result", () => {
  it.each(["email_send", "web_search", "telegram_send", "http_request", "web_fetch", "ari_http"])("%s", async (tool) => {
    const ctx = await audited(tool, { url: "https://example.com/", to: "a@b.example", query: "x" });
    expect(ctx.result?.status).toBe("blocked");
    expect(ctx.result?.metadata?.layer).toBe("threat");
  });

  it("covers the whole egress class, not a list", () => {
    expect(CAPABILITY_CLASS_MEMBERS.egress).toEqual(expect.arrayContaining(["email_send", "web_search", "telegram_send"]));
  });

  it("leaves a local read and the browser opening this app's own page alone", async () => {
    expect((await audited("read", { path: "notes.md" })).result?.status).toBe("ok");
    const port = process.env.LAX_PORT ?? "7007";
    expect((await audited("browser", { action: "navigate", url: `http://127.0.0.1:${port}/apps/x/` })).result?.status).toBe("ok");
  });
});
