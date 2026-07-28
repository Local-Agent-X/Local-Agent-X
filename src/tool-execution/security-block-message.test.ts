import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
// The SC-10 egress probe (enforce-policy.ts) renders its security blocker from
// the one canonical builder in security-layer-pack.ts — same function the
// pre-dispatch pack uses, so the two paths can never drift.
import { probeUpstreamEgressBlockers } from "./enforce-policy.js";
import { makeSecurityLayerPack, securityDenyRecovery } from "../tool-policy/packs/security-layer-pack.js";
import type { PackDecision } from "../tool-policy/evaluator.js";
import { USER_HINTS } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolCallContext } from "./context.js";

// Cross-seam contract for the security-block recovery message. The string used
// to live verbatim at TWO sites (the security-layer pack and the SC-10 egress
// probe) and had already drifted on the hint fallback: the pack forwarded an
// undefined layer userHint raw (dropping the user-facing line) while the probe
// defaulted it to USER_HINTS.policy. Both now render from securityDenyRecovery
// and share the same fallback. The message itself must also carry the
// escalation invariant: a live agent that hit a FALSE-POSITIVE block was told
// only "adjust the call" and responded by hand-patching build artifacts
// instead of telling the user what was blocked.

function denyingSecurity(userHint?: string): SecurityLayer {
  return {
    evaluate: () => ({ allowed: false, reason: "Path outside allowed roots", userHint }),
  } as unknown as SecurityLayer;
}

function makeCtx(security: SecurityLayer): ToolCallContext {
  const args = { path: "/etc/passwd" };
  return {
    tc: { id: "1", name: "write", arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security,
    sessionId: "sec-msg-test",
    callContext: "local",
    args,
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [] as ChatCompletionMessageParam[],
  } as ToolCallContext;
}

function packDeny(security: SecurityLayer): Extract<PackDecision, { allowed: false }> {
  const pack = makeSecurityLayerPack(security);
  const d = pack.evaluate(
    { id: "1", name: "write", args: { path: "/etc/passwd" } },
    { sessionId: "sec-msg-test", callContext: "local" },
  );
  if (d instanceof Promise) throw new Error("security pack evaluate is synchronous");
  if (d.allowed) throw new Error("expected a deny from the security-layer pack");
  return d;
}

describe("securityDenyRecovery — one canonical recovery for both security-block paths", () => {
  it("the pre-dispatch pack and the SC-10 egress probe render the identical string", () => {
    const deny = packDeny(denyingSecurity());
    expect(deny.allowed).toBe(false);

    const blockers = probeUpstreamEgressBlockers(makeCtx(denyingSecurity()));
    expect(blockers).toHaveLength(1);
    expect(blockers[0].layer).toBe("security");

    expect(deny.recovery).toBe(securityDenyRecovery());
    expect(blockers[0].recovery).toBe(securityDenyRecovery());
    expect(deny.recovery).toBe(blockers[0].recovery);
  });

  it("keeps the boundary guidance and adds the escalation instruction", () => {
    const msg = securityDenyRecovery();
    expect(msg).toMatch(/workspace and security boundaries/);
    expect(msg).toMatch(/stop and tell the user/i);
    // Escalation, not silent workaround: the false-positive path is "surface
    // the block", never "find another way around it".
    expect(msg).toMatch(/do not look for a workaround/i);
    expect(msg).toMatch(/adjust settings or approve another path/i);
  });

  it("never suggests the failure is transient", () => {
    const msg = securityDenyRecovery();
    expect(msg).toMatch(/denied again/i);
    expect(msg).not.toMatch(/transient|temporar|try again|later|wait|momentar/i);
  });

  it("both paths default an absent layer userHint to USER_HINTS.policy (the drift this test pins)", () => {
    const deny = packDeny(denyingSecurity(undefined));
    expect(deny.userHint).toBe(USER_HINTS.policy);

    const [blocker] = probeUpstreamEgressBlockers(makeCtx(denyingSecurity(undefined)));
    expect(blocker.userHint).toBe(USER_HINTS.policy);

    // A hint the layer DID supply passes through untouched on both paths.
    const supplied = packDeny(denyingSecurity("custom hint"));
    expect(supplied.userHint).toBe("custom hint");
    expect(probeUpstreamEgressBlockers(makeCtx(denyingSecurity("custom hint")))[0].userHint).toBe("custom hint");
  });

  it("the literal recovery text lives in exactly ONE source file (seam-drift guard)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const packSrc = readFileSync(
      join(here, "..", "tool-policy", "packs", "security-layer-pack.ts"),
      "utf-8",
    );
    const enforceSrc = readFileSync(join(here, "enforce-policy.ts"), "utf-8");

    const literal = "workspace and security boundaries";
    const filesWithLiteral = [packSrc, enforceSrc].filter((src) => src.includes(literal));
    expect(filesWithLiteral).toHaveLength(1);
    // …and it is the pack (the canonical builder), not the consumer.
    expect(packSrc).toContain(literal);
    expect(enforceSrc).not.toContain(literal);
    // The consumer renders through the builder instead.
    expect(enforceSrc).toContain("securityDenyRecovery()");
  });
});
