// A strict web-access refusal must reach the chat as something the USER can
// lift: the security layer names the host and the way out (BlockAction), the
// policy chain carries it unchanged (ToolBlocked.action), and the tool-result
// metadata the row renderer reads says `clearable: "allow-host"` with the host.
// Text alone is not enough: the notice renders off the flag, never the reason.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { SecurityLayer } from "../security/index.js";
import { assertToolCallAllowed, ToolBlocked } from "./pre-dispatch.js";
import { enforcePolicyPhase } from "./enforce-policy.js";
import { blockRecordOf } from "./block-record.js";
import { startAriKernel, stopAriKernel } from "../ari-kernel/lifecycle.js";
import type { ToolCallContext } from "./context.js";

let savedLaxDir: string | undefined;
let laxDir: string;
let security: SecurityLayer;
const prevKey = process.env.LAX_AUDIT_KEY;

beforeAll(() => {
  savedLaxDir = process.env.LAX_DATA_DIR;
  laxDir = mkdtempSync(join(tmpdir(), "allow-host-block-"));
  process.env.LAX_DATA_DIR = laxDir;
  process.env.LAX_AUDIT_KEY = "test-allow-host-block-key-0123456789";
  writeFileSync(join(laxDir, "security.json"), JSON.stringify({ egressMode: "strict" }));
  writeFileSync(join(laxDir, "egress-allowlist.json"), JSON.stringify(["allowed.example"]));
  security = new SecurityLayer("./workspace", "common");
});
afterAll(() => {
  if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = savedLaxDir;
  if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY; else process.env.LAX_AUDIT_KEY = prevKey;
  rmSync(laxDir, { recursive: true, force: true });
});
afterEach(() => { stopAriKernel(); });

const toolStub = (name: string) => ({ name, description: "", parameters: {}, execute: async () => ({ content: "" }) });

function makeCtx(name: string, args: Record<string, unknown>): ToolCallContext {
  return {
    tc: { id: "1", name, arguments: JSON.stringify(args) },
    toolMap: new Map([[name, toolStub(name)]]),
    security,
    rbac: undefined as never,
    callerRole: undefined,
    toolPolicy: undefined as never,
    sessionId: "test",
    callContext: "local",
    skipSessionPolicy: true,
    args,
    msgs: [] as ChatCompletionMessageParam[],
    allowed: true,
    result: undefined,
  } as unknown as ToolCallContext;
}

describe("strict web access refusals carry the allow-host action", () => {
  it("the pre-dispatch chain throws ToolBlocked with the host to allow", async () => {
    const pre = { sessionId: "test", callContext: "local" as const, security, skipSessionPolicy: true };
    let thrown: unknown;
    try { await assertToolCallAllowed({ id: "1", name: "web_fetch", args: { url: "https://docs.example.org/page" } }, pre); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ToolBlocked);
    expect((thrown as ToolBlocked).action).toEqual({ kind: "allow-host", host: "docs.example.org" });
    // The allowlisted host passes the same gate untouched.
    await expect(assertToolCallAllowed({ id: "2", name: "web_fetch", args: { url: "https://allowed.example/" } }, pre)).resolves.toBeUndefined();
  });

  it("with the kernel live and the session clean, the block's metadata and durable record name the host", async () => {
    await startAriKernel(join(laxDir, "ari-audit.db"), "workspace-assistant", true);
    const ctx = makeCtx("http_request", { url: "https://api.other.example/v1", method: "GET" });
    await enforcePolicyPhase(ctx);
    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.status).toBe("blocked");
    expect(ctx.result?.metadata?.layer).toBe("security");
    expect(ctx.result?.metadata?.clearable).toBe("allow-host");
    expect(ctx.result?.metadata?.host).toBe("api.other.example");
    expect(String(ctx.result?.content)).toMatch(/Settings → Security → Web access/);
    // What the reloaded card renders from.
    const record = blockRecordOf(ctx.result!);
    expect(record?.clearable).toBe("allow-host");
    expect(record?.host).toBe("api.other.example");
    expect(record?.notice).toBe("allow-host-card");
    expect(record?.scope).toBeUndefined();
  });

  it("the browser tool's navigate is judged by the same policy and names the same way out", async () => {
    await startAriKernel(join(laxDir, "ari-audit.db"), "workspace-assistant", true);
    const ctx = makeCtx("browser", { action: "navigate", url: "https://shop.example.net/cart" });
    await enforcePolicyPhase(ctx);
    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.metadata?.clearable).toBe("allow-host");
    expect(ctx.result?.metadata?.host).toBe("shop.example.net");
  });

  it("when the kernel co-denies, the aggregate still offers the host as the way out", async () => {
    // No kernel started: the required-but-inactive deny joins the security
    // blocker in one aggregate. The security probe must not drop the action.
    const ctx = makeCtx("http_request", { url: "https://api.other.example/v1", method: "GET" });
    await enforcePolicyPhase(ctx);
    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.metadata?.layer).toBe("egress-aggregate");
    expect(ctx.result?.metadata?.layers).toContain("security");
    expect(ctx.result?.metadata?.clearable).toBe("allow-host");
    expect(ctx.result?.metadata?.host).toBe("api.other.example");
    expect(blockRecordOf(ctx.result!)?.notice).toBe("allow-host-card");
  });
});
