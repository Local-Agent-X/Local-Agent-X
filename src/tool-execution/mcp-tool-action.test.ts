// An MCP server tool used to reach the kernel as an http GET whatever it did,
// so a preset that denies tainted writes could never see a tainted create,
// send or delete, and its arguments were not an egress payload for any
// outbound scan (red team 2026-10-13, B2). Its kernel action now comes from
// the server's own listing — a write unless marked read-only — and its
// arguments are egress like any other off-box call.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetMcpServerTools, recordMcpServerTools } from "../mcp-client/tool-facts.js";
import { ariActionOf, hasCapability, isReadOnlyCall } from "../tool-registry.js";
import { egressPayload } from "./egress-payload.js";
import { startAriKernel, stopAriKernel, ariEvaluate } from "../ari-kernel/index.js";

const SERVER = "ghtest";
const CREATE = `mcp_${SERVER}_create_issue`;
const GET = `mcp_${SERVER}_get_issue`;

describe("a connected MCP server tool's kernel action and egress class", () => {
  beforeEach(() => {
    recordMcpServerTools(SERVER, [{ name: "create_issue" }, { name: "get_issue", annotations: { readOnlyHint: true } }]);
  });
  afterEach(() => forgetMcpServerTools(SERVER));

  it("is a write unless the server marked it read-only", () => {
    expect(ariActionOf(CREATE, { title: "x" })).toBe("post");
    expect(ariActionOf(GET, { number: 1 })).toBe("get");
    expect(isReadOnlyCall(CREATE, { title: "x" })).toBe(false);
  });

  it("is an egress sink and nothing else; its arguments are the outbound payload", () => {
    expect(hasCapability(CREATE, "egress")).toBe(true);
    expect(hasCapability(GET, "egress")).toBe(true);
    for (const cls of ["shell", "sensitive-read", "workspace-write"] as const) expect(hasCapability(CREATE, cls), cls).toBe(false);
    const { text } = egressPayload(CREATE, { title: "Rotate the key", body: { note: "sk-live-example" } });
    expect(text).toContain("Rotate the key");
    expect(text).toContain("sk-live-example");
  });

  it("a server tool the listing never named has no facts: the kernel's fail-closed default stands", () => {
    expect(ariActionOf(`mcp_${SERVER}_unlisted`, {})).toBe("exec");
    expect(hasCapability(`mcp_${SERVER}_unlisted`, "egress")).toBe(false);
  });
});

describe("the kernel judges a tainted MCP write as a tainted write", () => {
  let dir: string;
  const prevKey = process.env.LAX_AUDIT_KEY;

  beforeEach(async () => {
    recordMcpServerTools(SERVER, [{ name: "create_issue" }, { name: "get_issue", annotations: { readOnlyHint: true } }]);
    process.env.LAX_AUDIT_KEY = "test-mcp-tool-action-key-0123456789";
    dir = mkdtempSync(join(tmpdir(), "lax-mcp-action-"));
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
  });
  afterEach(() => {
    stopAriKernel();
    forgetMcpServerTools(SERVER);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  it("a clean create is allowed, a tainted create is denied, a tainted read-only call is allowed", async () => {
    const clean = await ariEvaluate(CREATE, ariActionOf(CREATE, {}), { title: "x" }, []);
    expect(clean.allowed).toBe(true);
    const tainted = await ariEvaluate(CREATE, ariActionOf(CREATE, {}), { title: "x" }, ["rag"]);
    expect(tainted.allowed).toBe(false);
    const read = await ariEvaluate(GET, ariActionOf(GET, {}), { number: 1 }, ["rag"]);
    expect(read.allowed).toBe(true);
  });
});
