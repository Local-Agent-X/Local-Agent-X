import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkEgressTaint,
  clearSessionTaint,
  detectSecretsInOutput,
} from "./index.js";
import { runSandboxedPhase } from "../tool-execution/run-sandboxed.js";
import type { ToolCallContext } from "../tool-execution/context.js";
import type { ToolDefinition } from "../types.js";

// Regression tests for the redaction seam, updated for the delivery-point
// invariant: when a tool reads a sensitive source the result must NOT contain
// the raw bytes by the time it lands in ctx.result (the model never gets first
// sight) — and BECAUSE the stub is what got delivered, the session must NOT be
// tainted (nothing sensitive entered context, so there is nothing to quarantine;
// outbound sends are still independently scanned by the egress guard).
describe("run-sandboxed redacts sensitive results before delivery (no taint on stub)", () => {
  function makeCtx(input: {
    name: string;
    args: Record<string, unknown>;
    tool: ToolDefinition;
    sessionId: string;
  }): ToolCallContext {
    return {
      tc: { id: "1", name: input.name, arguments: JSON.stringify(input.args) },
      toolMap: new Map(),
      // SecurityLayer is unused by runSandboxedPhase but the type requires it.
      security: undefined as never,
      sessionId: input.sessionId,
      callContext: "local",
      args: input.args,
      tool: input.tool,
      riskLevel: "low",
      approvalContext: "",
      allowed: true,
      msgs: [],
    } as ToolCallContext;
  }

  it("read of a sensitive path: ctx.result.content does not contain the secret bytes", async () => {
    const sentinel = "SENSITIVE_TEST_PAYLOAD_8a3f";
    const dir = mkdtempSync(join(tmpdir(), "lineage-redact-"));
    // secrets.json matches isSensitivePath via /secrets?\.(enc|json|yaml|yml)/i
    const file = join(dir, "secrets.json");
    writeFileSync(file, sentinel, "utf-8");

    const readStub: ToolDefinition = {
      name: "read",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute(args) {
        // Return the file's contents verbatim — what the real read tool
        // would have placed into ctx.result before redaction.
        return { content: `1\t${sentinel}`, isError: false };
      },
    };

    const sessionId = "redact-read-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "read", args: { path: file }, tool: readStub, sessionId });

    try {
      await runSandboxedPhase(ctx);

      expect(ctx.result).toBeDefined();
      // The whole point: the sentinel bytes must NOT reach ctx.result.
      expect(ctx.result!.content).not.toContain(sentinel);
      expect(ctx.result!.status).toBe("blocked");
      expect(ctx.result!.metadata?.redacted).toBe(true);
      // Delivery-point invariant: the stub is what reached the model, so the
      // session stays clean — the provisional pre-execute floor is retracted.
      expect(checkEgressTaint(sessionId).blocked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("benign read: ctx.result passes through unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-redact-"));
    const file = join(dir, "notes.txt");
    writeFileSync(file, "hello world", "utf-8");

    const readStub: ToolDefinition = {
      name: "read",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: "1\thello world", isError: false };
      },
    };

    const sessionId = "redact-benign-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "read", args: { path: file }, tool: readStub, sessionId });

    try {
      await runSandboxedPhase(ctx);
      expect(ctx.result?.content).toContain("hello world");
      expect(ctx.result?.status).not.toBe("blocked");
      expect(checkEgressTaint(sessionId).blocked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F4 defense-in-depth: confinement (the file-access gate) is the primary
  // control for sql_query, but a secret-shaped value sitting in an in-workspace
  // SQLite row must still be redacted like web_fetch/http_request output — not
  // pass through to the model. The stub delivery means no taint (delivery-point
  // invariant). Guards keeping sql_query in the output scan.
  it("sql_query output containing a secret: result redacted, session NOT tainted", async () => {
    const secret = "AKIA0000000000000000"; // aws-access-key shape
    const sqlStub: ToolDefinition = {
      name: "sql_query",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      // Mirror the wrapExternalContent-wrapped markdown table the real tool returns.
      async execute() {
        return { content: `[external: sql_query]\n| api_key |\n| --- |\n| ${secret} |`, isError: false };
      },
    };
    const sessionId = "redact-sql-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({
      name: "sql_query",
      args: { database: "workspace/app.db", query: "SELECT api_key FROM creds" },
      tool: sqlStub,
      sessionId,
    });

    await runSandboxedPhase(ctx);

    expect(ctx.result).toBeDefined();
    expect(ctx.result!.content).not.toContain(secret);
    expect(ctx.result!.status).toBe("blocked");
    expect(ctx.result!.metadata?.redacted).toBe(true);
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  // The run-killer fix: a secret-shaped span in UNTRUSTED INBOUND web content
  // must be redacted from the model's view but must NOT discard the whole page
  // or taint the session's egress (a coincidental `sk-…`/AKIA on a trade page
  // previously bricked every downstream tool call for the run).
  it("web_fetch with a secret-shaped span: span redacted inline, page kept, NO taint", async () => {
    const secret = "AKIA0000000000000000";
    const fetchStub: ToolDefinition = {
      name: "web_fetch",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: `Supplement market grew. Ref ${secret}. Collagen up 12%.`, isError: false };
      },
    };
    const sessionId = "web-fetch-inbound";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({
      name: "web_fetch",
      args: { url: "https://example-trade-site.com/report" },
      tool: fetchStub,
      sessionId,
    });

    await runSandboxedPhase(ctx);

    expect(ctx.result).toBeDefined();
    // Secret stripped from the model's view...
    expect(ctx.result!.content).not.toContain(secret);
    expect(ctx.result!.content).toContain("[redacted-secret:AWS Access Key]");
    // ...but the rest of the page survives (not blanket-redacted to a stub)...
    expect(ctx.result!.content).toContain("Collagen up 12%");
    expect(ctx.result!.status).not.toBe("blocked");
    // ...and egress is NOT tainted — downstream search/fetch still work.
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  it("benign web_fetch passes through unchanged", async () => {
    const fetchStub: ToolDefinition = {
      name: "web_fetch",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: "Creatine and collagen demand rose in Q2 2026.", isError: false };
      },
    };
    const sessionId = "web-fetch-benign";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({
      name: "web_fetch",
      args: { url: "https://example.com" },
      tool: fetchStub,
      sessionId,
    });

    await runSandboxedPhase(ctx);
    expect(ctx.result?.content).toContain("Creatine and collagen");
    expect(ctx.result?.status).not.toBe("blocked");
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  it("benign sql_query output passes through unchanged", async () => {
    const sqlStub: ToolDefinition = {
      name: "sql_query",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: `| id | name |\n| --- | --- |\n| 1 | alice |`, isError: false };
      },
    };
    const sessionId = "redact-sql-benign";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({
      name: "sql_query",
      args: { database: "workspace/app.db", query: "SELECT id, name FROM users" },
      tool: sqlStub,
      sessionId,
    });

    await runSandboxedPhase(ctx);
    expect(ctx.result?.content).toContain("alice");
    expect(ctx.result?.status).not.toBe("blocked");
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  // Capability-class re-keying: sensitive reads via SYNONYMS (ari_file path,
  // email_read / memory_search output) must trigger the same redaction stub as
  // read/sql_query — and, per the delivery-point invariant, the same no-taint
  // outcome when the stub is what got delivered.
  it("ari_file read of a sensitive path: redacts, session NOT tainted", async () => {
    const sentinel = "ARI_FILE_SENTINEL_77c2";
    const dir = mkdtempSync(join(tmpdir(), "lineage-arifile-"));
    const file = join(dir, "secrets.json");
    writeFileSync(file, sentinel, "utf-8");
    const stub: ToolDefinition = {
      name: "ari_file",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { return { content: sentinel, isError: false }; },
    };
    const sessionId = "redact-arifile-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "ari_file", args: { action: "read", path: file }, tool: stub, sessionId });
    try {
      await runSandboxedPhase(ctx);
      expect(ctx.result!.content).not.toContain(sentinel);
      expect(ctx.result!.status).toBe("blocked");
      expect(ctx.result!.metadata?.redacted).toBe(true);
      expect(checkEgressTaint(sessionId).blocked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("email_read output containing a secret: redacts, session NOT tainted", async () => {
    const secret = "AKIA0000000000000000";
    const stub: ToolDefinition = {
      name: "email_read",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { return { content: `From: ops\nBody: api key ${secret}`, isError: false }; },
    };
    const sessionId = "redact-emailread-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "email_read", args: { folder: "INBOX" }, tool: stub, sessionId });
    await runSandboxedPhase(ctx);
    expect(ctx.result!.content).not.toContain(secret);
    expect(ctx.result!.status).toBe("blocked");
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  it("memory_search output containing a secret: redacts, session NOT tainted", async () => {
    const secret = "AKIA0000000000000000";
    const stub: ToolDefinition = {
      name: "memory_search",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { return { content: `recalled: stored token ${secret}`, isError: false }; },
    };
    const sessionId = "redact-memsearch-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "memory_search", args: { query: "token" }, tool: stub, sessionId });
    await runSandboxedPhase(ctx);
    expect(ctx.result!.content).not.toContain(secret);
    expect(ctx.result!.status).toBe("blocked");
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  it("memory_search output containing only a high-entropy identifier does not taint", async () => {
    const identifier = "useIframeNavigationApiHandlerFactory7f3a9c1e";
    const detected = detectSecretsInOutput(identifier);
    expect(detected.matched).toBe(true);
    expect(detected.structured).toBe(false);

    const stub: ToolDefinition = {
      name: "memory_search",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { return { content: `recalled tool id: ${identifier}`, isError: false }; },
    };
    const sessionId = "memsearch-entropy-only-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "memory_search", args: { query: "tool id" }, tool: stub, sessionId });
    await runSandboxedPhase(ctx);
    expect(ctx.result!.content).toContain(identifier);
    expect(ctx.result!.status).not.toBe("blocked");
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });
});
