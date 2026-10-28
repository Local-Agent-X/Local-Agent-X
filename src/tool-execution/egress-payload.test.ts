// The outbound scans read every argument an egress tool is handed, not the ones
// someone remembered to list. Driven over the runtime catalog, so a new egress
// tool, or a new parameter on one, is covered the day it is registered.

import { describe, it, expect, beforeAll } from "vitest";
import type { ToolDefinition } from "../types.js";
import { collectRuntimeTools } from "../tools/runtime-tool-names.js";
import { CAPABILITY_CLASS_MEMBERS, hasCapability, localArgsOf, toolsWhere } from "../tool-registry.js";
import { generateCanaries, registerSessionCanaries, clearSessionCanaries } from "../threat/canaries.js";
import { egressGuardGate } from "./enforce-policy.js";
import { probeCanary, probeEgressGuard } from "./egress-gates.js";
import { egressPayload } from "./egress-payload.js";
import { makeCtx } from "./capability-class-gates.test-helper.js";

const SECRET = "AKIA0000000000000000"; // AWS access-key shape
const PLACEHOLDER = "{{API_KEY}}";

type ParamSchema = { type?: string };

let catalog: Map<string, ToolDefinition>;
beforeAll(async () => {
  catalog = await collectRuntimeTools();
}, 60_000);

function egressTools(): string[] {
  return [...new Set([...CAPABILITY_CLASS_MEMBERS.egress, ...catalog.keys()])].filter((n) => hasCapability(n, "egress"));
}

function declaredParams(tool: string): Record<string, ParamSchema> {
  const params = catalog.get(tool)?.parameters as { properties?: Record<string, ParamSchema> } | undefined;
  return params?.properties ?? {};
}

/** Every declared parameter of every egress tool that the payload must carry. */
function payloadParams(): Array<[tool: string, param: string, schema: ParamSchema]> {
  return egressTools().flatMap((tool) =>
    Object.entries(declaredParams(tool))
      .filter(([param]) => !localArgsOf(tool).includes(param))
      .map(([param, schema]): [string, string, ParamSchema] => [tool, param, schema]));
}

/** `value` the way the parameter's own type carries text: itself, an element, a field. */
function carrying(schema: ParamSchema, value: string): unknown {
  if (schema.type === "array") return [value];
  if (schema.type === "object") return { field: value };
  return value;
}

describe("the outbound scans cover every argument of every egress tool", () => {
  it("every egress-class tool is in the runtime catalog, so the sweep below is not vacuous", () => {
    const missing = CAPABILITY_CLASS_MEMBERS.egress.filter((n) => !catalog.has(n));
    expect(missing).toEqual([]);
    expect(payloadParams().length).toBeGreaterThan(100);
  });

  it("a hardcoded secret in any declared parameter is caught by the outbound secret scan", () => {
    const missed = payloadParams()
      .filter(([tool, param, schema]) => probeEgressGuard(makeCtx(tool, { [param]: carrying(schema, `k=${SECRET}`) }, "egress-payload-secret")) === null)
      .map(([tool, param]) => `${tool}.${param}`);
    expect(missed, `arguments the secret scan never reads: ${missed.join(", ")}`).toEqual([]);
  });

  it("a session canary in any declared parameter trips the canary tripwire", () => {
    const sid = "egress-payload-canary";
    const [canary] = generateCanaries();
    registerSessionCanaries(sid, [canary]);
    try {
      const missed = payloadParams()
        .filter(([tool, param, schema]) => probeCanary(makeCtx(tool, { [param]: carrying(schema, `ref ${canary}`) }, sid)) === null)
        .map(([tool, param]) => `${tool}.${param}`);
      expect(missed, `arguments the canary tripwire never reads: ${missed.join(", ")}`).toEqual([]);
    } finally {
      clearSessionCanaries(sid);
    }
  });

  it("a {{SECRET_NAME}} placeholder in any declared parameter passes the secret scan", () => {
    // A body alone makes an http_request a GET with a body (its default method),
    // refused for that by its own rule, which is not the secret scan.
    const refused = payloadParams()
      .filter(([tool, param, schema]) => {
        const block = probeEgressGuard(makeCtx(tool, { [param]: carrying(schema, PLACEHOLDER) }, "egress-payload-placeholder"));
        return block !== null && block.meta?.blocked_by !== "get-head-body-forbidden";
      })
      .map(([tool, param]) => `${tool}.${param}`);
    expect(refused, `placeholders refused in: ${refused.join(", ")}`).toEqual([]);
  });

  it("every local-control exemption names an egress tool and a parameter it declares", () => {
    const declaring = toolsWhere((row) => (row.localArgs?.length ?? 0) > 0);
    expect(declaring).toEqual(expect.arrayContaining(["browser", "computer"]));
    const stale = declaring.flatMap((tool) =>
      localArgsOf(tool).filter((a) => !hasCapability(tool, "egress") || !(a in declaredParams(tool))).map((a) => `${tool}.${a}`));
    expect(stale).toEqual([]);
  });
});

describe("egressPayload", () => {
  it("scans a process_restart command (the argument the per-tool list never read)", () => {
    expect(egressGuardGate(makeCtx("process_restart", { command: `deploy --key=${SECRET}` }, "egress-payload-restart")).kind).toBe("halt");
    expect(egressGuardGate(makeCtx("process_restart", { command: "npm run dev", port: 3000 }, "egress-payload-restart")).kind).toBe("continue");
  });

  it("never reads the server-stamped `_` arguments", () => {
    const args = { text: "hello", _lastUserMessage: `my key is ${SECRET}`, _cwd: "/srv/app" };
    expect(egressPayload("clipboard_write", args).text).toBe("hello");
    expect(egressGuardGate(makeCtx("clipboard_write", args, "egress-payload-internal")).kind).toBe("continue");
  });

  it("reads nested values and the names that ride with them", () => {
    const { text } = egressPayload("process_start", { command: "node app.js", env: { DEPLOY_TOKEN: SECRET } });
    expect(text.split("\n")).toEqual(["node app.js", "DEPLOY_TOKEN", SECRET]);
  });

  it("reads a number in a payload slot, but a pointer action carries nothing", () => {
    expect(egressPayload("computer", { action: "type", text: 842130 }).text).toBe("842130");
    expect(egressPayload("computer", { action: "click", x: 5, y: 9, button: "left", target: "os-desktop" }).text).toBe("");
    expect(egressPayload("browser", { action: "click", ref: 3, selector: "#submit" }).text).toBe("");
  });
});
