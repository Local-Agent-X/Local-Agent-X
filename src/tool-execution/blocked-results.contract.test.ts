/**
 * A refusal always names the next step. The ToolResult type makes
 * metadata.recovery required on every blocked result; these pin the rest of
 * the contract: the stage defaults never steer around a security decision,
 * and the recovery survives every hop to the model (render, re-parse at the
 * dispatch boundary, a refusal raised by a pre-dispatch stage).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BLOCKED_WITHOUT_RECOVERY, blocked, renderToolResultForModel, resultFromRendered } from "../tools/result-helpers.js";
import { STAGE_RECOVERY } from "./stage-recovery.js";
import { dispatchSingleToolCall } from "./execute-tool.js";
import { _clearDedupCacheForTests } from "./dedup-cache.js";
import { setAriRequired } from "../ari-kernel/state.js";
import { RBACManager } from "../rbac.js";
import { ThreatEngine } from "../threat/threat-engine.js";
import type { ToolDefinition, ToolResult } from "../types.js";

// Compile-time half of the contract: tsc (the build) fails if either line
// stops being an error.
// @ts-expect-error a blocked result must carry metadata.recovery
const _noRecovery: ToolResult = { content: "refused", isError: true, status: "blocked" };
// @ts-expect-error blocked() takes the recovery as a required field
const _helperNoRecovery = blocked("refused", { layer: "x" });
void _noRecovery; void _helperNoRecovery;

function stub(name: string, result: ToolResult): ToolDefinition {
  return {
    name, description: "", parameters: { type: "object", properties: {} },
    readOnly: true, concurrencySafe: true,
    execute: async (): Promise<ToolResult> => result,
  } as unknown as ToolDefinition;
}

describe("stage defaults", () => {
  it("every stage tells the model what the user can do and to keep going with the rest", () => {
    for (const [stage, text] of Object.entries(STAGE_RECOVERY)) {
      expect(text, stage).toMatch(/\b(user|them)\b/);
      expect(text, stage).toMatch(/[Cc]ontinue/);
    }
  });

  it("a security, kernel, or threat refusal never invites a way around it", () => {
    for (const stage of ["security", "arikernel", "threat"] as const) {
      expect(STAGE_RECOVERY[stage], stage).toMatch(/Do not (look for another way around it|retry it another way)/);
    }
  });
});

describe("the recovery reaches the model", () => {
  it("renders on its own line and comes back from the rendered text", () => {
    const rendered = renderToolResultForModel(blocked("refused", { recovery: "Ask the user to allow it." }));
    expect(rendered).toMatch(/^Recovery: Ask the user to allow it\.$/m);
    const back = resultFromRendered(rendered);
    expect(back.status).toBe("blocked");
    expect(back.metadata?.recovery).toBe("Ask the user to allow it.");
  });

  // The type is satisfied by "" and a rebuilt envelope can lose its line;
  // the render seam every result passes still names a next step.
  it("a refusal that arrives with no next step still reaches the model with one", () => {
    const empty = renderToolResultForModel(blocked("refused", { recovery: "" }));
    expect(empty).toContain(`Recovery: ${BLOCKED_WITHOUT_RECOVERY}`);
    const rebuilt = resultFromRendered("[blocked, layer=\"x\"]\nrefused");
    expect(renderToolResultForModel(rebuilt)).toContain(`Recovery: ${BLOCKED_WITHOUT_RECOVERY}`);
  });

  describe("through dispatch", () => {
    let tmpRoot: string;
    let rbac: RBACManager;
    let restricted: ThreatEngine;
    beforeAll(() => {
      setAriRequired(false);
      _clearDedupCacheForTests();
      tmpRoot = mkdtempSync(join(tmpdir(), "blocked-contract-"));
      rbac = new RBACManager(join(tmpRoot, "rbac"), "contract-operator-token");
      restricted = new ThreatEngine(join(tmpRoot, "threat"), "contract-threat-sess");
      restricted.scorer.record("canary_tripped", 100, "contract: confirmed breach latch");
    });
    afterAll(() => {
      setAriRequired(true);
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("a tool's own refusal keeps its recovery", async () => {
      const toolMap = new Map([["refuser", stub("refuser", blocked("no", { recovery: "Use the other route." }))]]);
      const r = await dispatchSingleToolCall({ id: "c1", name: "refuser", args: {} }, { toolMap, security: undefined as never, callContext: "api" });
      expect(r.status).toBe("blocked");
      expect(r.metadata?.recovery).toBe("Use the other route.");
    });

    it("a stage refusal that names its own next step keeps it", async () => {
      const toolMap = new Map([["write", stub("write", { content: "wrote" })]]);
      const r = await dispatchSingleToolCall(
        { id: "c2", name: "write", args: { path: "a.txt", content: "x" } },
        { toolMap, security: undefined as never, callContext: "api", rbac, callerRole: "readonly" },
      );
      expect(r.status).toBe("blocked");
      expect(r.metadata?.recovery).toMatch(/ask the user/);
    });

    it("a threat-monitor pause says what can still be done", async () => {
      const toolMap = new Map([["http_request", stub("http_request", { content: "sent" })]]);
      const r = await dispatchSingleToolCall(
        { id: "c3", name: "http_request", args: { url: "https://example.com" } },
        { toolMap, security: undefined as never, callContext: "api", threatEngine: restricted, sessionId: "contract-threat-sess" },
      );
      expect(r.status).toBe("blocked");
      expect(r.metadata?.recovery).toMatch(/Continue with work that does not need them/);
    });
  });
});
