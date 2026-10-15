// A session-policy refusal is a refusal everywhere it is read. It used to go
// out raw — a two-line string with no status header — so the canonical event
// log and the reloaded chat recorded the refused call as "ok", the same bug the
// kernel deny had until kernelDenyResult. terminate() no longer accepts a raw
// refusal at all; this pins the one gate in enforce-policy that sent one.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setAriRequired } from "../ari-kernel/state.js";
import { clearSessionPolicy, setSessionPolicy } from "../session/policy.js";
import { parseResultHeader } from "../tools/result-helpers.js";
import type { ToolBlockRecord, ToolDefinition } from "../types.js";
import { makeCtx } from "./capability-class-gates.test-helper.js";
import { enforcePolicyPhase } from "./enforce-policy.js";

const SID = "session-policy-block-test";

const write: ToolDefinition = {
  name: "write",
  description: "",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  execute: async () => ({ content: "WROTE" }),
} as unknown as ToolDefinition;

beforeAll(() => setAriRequired(false));
afterAll(() => setAriRequired(true));
afterEach(() => clearSessionPolicy(SID));

describe("a session-policy refusal reads as blocked", () => {
  it("halts with a blocked result, a recovery, and a block record — never a raw string logged ok", async () => {
    setSessionPolicy(SID, "read-only");
    const ctx = makeCtx("write", { path: "notes.md", content: "x" }, SID);
    (ctx as { toolMap: Map<string, ToolDefinition> }).toolMap = new Map([["write", write]]);

    await enforcePolicyPhase(ctx);

    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.status).toBe("blocked");
    expect(ctx.result?.metadata?.layer).toBe("session-policy");
    expect(String(ctx.result?.metadata?.recovery ?? "")).not.toBe("");
    const msg = ctx.msgs.at(-1) as { content?: unknown; _block?: ToolBlockRecord };
    expect(parseResultHeader(String(msg.content))?.status).toBe("blocked");
    expect(String(msg.content)).toContain("Blocked by session policy");
    expect(msg._block?.layer).toBe("session-policy");
  });
});
