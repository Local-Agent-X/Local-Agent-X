// Rows the execute phase builds itself still carry the tool's bytes: a hung
// command's streamed stdout/stderr (partial_output on the [timeout] row), a
// transient error the runner gave up retrying, and a thrown error's message.
// Each reaches the model, so each passes the same delivery-point mask as a
// normal result — a registered secret printed by a command that then hangs must
// never be shown.
//
// Drives the real runSandboxedPhase and the real tool runner (timeout + retry);
// only the tools are stand-ins.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { setToolTimeout } from "./tool-timeout.js";
import { renderToolResultForModel } from "../tools/result-helpers.js";
import { clearSessionTaint } from "../data-lineage/index.js";
import { registerRedactedSecretValue, unregisterRedactedSecretValue } from "../security/secrets/index.js";
import type { ToolCallContext } from "./context.js";
import type { ToolDefinition, ToolResult } from "../types.js";

const SECRET = "dummy-Registered-Value-7Q2xK9";
const HANGING_TOOL = "masking_probe_hang";

let seq = 0;
async function deliver(tool: ToolDefinition, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const sessionId = `mask-row-${seq++}`;
  const ctx = {
    tc: { id: `tc${seq}`, name: tool.name, arguments: JSON.stringify(args) },
    toolMap: new Map([[tool.name, tool]]),
    tool, args, sessionId, callContext: "local", riskLevel: "low", approvalContext: "", allowed: true, msgs: [],
  } as unknown as ToolCallContext;
  await runSandboxedPhase(ctx);
  clearSessionTaint(sessionId);
  return ctx.result!;
}

describe("rows the execute phase builds are masked like any delivered result", () => {
  beforeAll(() => {
    registerRedactedSecretValue(SECRET);
    // The hang-catcher's deadline, shortened for this probe tool only.
    setToolTimeout(HANGING_TOOL, 50);
  });
  afterAll(() => unregisterRedactedSecretValue(SECRET));

  it("a hanging command's streamed output reaches partial_output with the secret masked", async () => {
    const hanging = {
      name: HANGING_TOOL,
      description: "streams then hangs",
      parameters: { type: "object", properties: {} },
      execute: (args: Record<string, unknown>) => {
        const progress = args._onProgress as (m: string) => void;
        progress("connecting to db");
        progress(`[stderr] auth failed for key ${SECRET}`);
        return new Promise<ToolResult>(() => {});
      },
    } as unknown as ToolDefinition;
    const res = await deliver(hanging);
    expect(res.status).toBe("timeout");
    const shown = renderToolResultForModel(res);
    expect(shown).toContain("connecting to db");
    expect(shown).toContain("auth failed for key ");
    expect(shown).not.toContain(SECRET);
    expect(res.metadata?.secrets_masked).toBe(1);
  });

  it("a transient error the runner gave up retrying is delivered with the secret masked", async () => {
    let attempts = 0;
    const flaky = {
      name: "masking_probe_flaky",
      description: "always 503",
      parameters: { type: "object", properties: {} },
      effect: { class: "read-only" },
      execute: async () => {
        attempts++;
        return { content: `503 Service Unavailable (upstream echoed ${SECRET})`, isError: true, metadata: { status: 503 } };
      },
    } as unknown as ToolDefinition;
    const res = await deliver(flaky);
    expect(attempts).toBe(3); // the retry path, not a first-attempt delivery
    expect(res.isError).toBe(true);
    expect(res.content).toContain("503 Service Unavailable");
    expect(renderToolResultForModel(res)).not.toContain(SECRET);
  }, 20_000);

  it("a thrown error's message is delivered with the secret masked", async () => {
    const throwing = {
      name: "masking_probe_throw",
      description: "throws",
      parameters: { type: "object", properties: {} },
      execute: async () => { throw new Error(`could not parse config: token=${SECRET}`); },
    } as unknown as ToolDefinition;
    const res = await deliver(throwing);
    expect(res.content).toContain("Tool error: could not parse config: token=");
    expect(renderToolResultForModel(res)).not.toContain(SECRET);
  });
});
