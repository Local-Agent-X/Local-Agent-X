// The model never sees a registered secret value, whichever tool's output
// carries it. The operator token is the sharpest case: config.json sits in the
// data dir, which every file-access mode lets the agent read, and a token the
// model has seen can be written into a request to this server's own API.
//
// Drives the real config loader (an isolated data dir: test/setup/test-env.ts
// points HOME at a temp dir) and the real execute phase. read, grep and
// document are the real tools; bash is a stand-in whose stdout is what a
// `cat` of the file prints, since the seam keys on the tool name. Its timeout
// and error rows are built the way shell-tool.ts builds them, and checked as
// renderToolResultForModel prints them: the header and the partial output
// carry output that the content does not.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { loadConfig, setRuntimeConfig, rotateAuthToken, getConfigPath } from "../config.js";
import { evaluateFileAccess } from "../security/layer/index.js";
import { readTool } from "../tools/file-tools.js";
import { grepTool } from "../tools/grep-tool.js";
import { documentTools } from "../tools/document-tools.js";
import { err, timeout, renderToolResultForModel } from "../tools/result-helpers.js";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { clearSessionTaint } from "../data-lineage/index.js";
import { unregisterRedactedSecretValue } from "../security/secrets/index.js";
import type { ToolCallContext } from "./context.js";
import type { ToolDefinition, ToolResult } from "../types.js";

let seq = 0;
async function deliver(tool: ToolDefinition, args: Record<string, unknown>): Promise<ToolResult> {
  const sessionId = `optoken-${seq++}`;
  const ctx = {
    tc: { id: `tc${seq}`, name: tool.name, arguments: JSON.stringify(args) },
    toolMap: new Map([[tool.name, tool]]),
    tool, args, sessionId, callContext: "local", riskLevel: "low", approvalContext: "", allowed: true, msgs: [],
  } as unknown as ToolCallContext;
  await runSandboxedPhase(ctx);
  clearSessionTaint(sessionId);
  return ctx.result!;
}

function rowTool(name: string, row: ToolResult): ToolDefinition {
  return {
    name,
    description: "stand-in",
    parameters: { type: "object", properties: {} },
    execute: async () => row,
  } as ToolDefinition;
}

const stdoutTool = (name: string, stdout: string): ToolDefinition => rowTool(name, { content: stdout });

async function docxWith(text: string, dir: string): Promise<string> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  const path = join(dir, "handoff.docx");
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
  return path;
}

describe("the operator token never reaches the model", () => {
  let token: string;
  let configPath: string;
  let scratch: string;

  beforeAll(() => {
    const config = loadConfig();
    setRuntimeConfig(config);
    token = config.authToken;
    configPath = getConfigPath();
    scratch = mkdtempSync(join(tmpdir(), "lax-optoken-"));
  });
  afterAll(() => {
    unregisterRedactedSecretValue(token);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("sanity: config.json holds the token and the file gate lets even workspace mode read it", () => {
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(configPath, "utf-8")).toContain(token);
    const decision = evaluateFileAccess(scratch, "workspace", () => false, "read", configPath);
    expect(decision.allowed).toBe(true);
  });

  it("read of config.json shows every setting with the token masked", async () => {
    const res = await deliver(readTool, { path: configPath });
    expect(res.status).not.toBe("blocked");
    expect(res.content).toContain('"authToken"');
    expect(res.content).toContain('"browserMode": "in-app"');
    expect(res.content).not.toContain(token);
    expect(res.content).toMatch(/1 secret value masked \(Known Secret Value\)/);
    expect(res.metadata?.secrets_masked).toBe(1);
  });

  it("grep over the data dir masks the token in the matching line", async () => {
    const res = await deliver(grepTool, { pattern: "authToken", path: dirname(configPath), output_mode: "content", context: 0 });
    expect(res.content).toContain("authToken");
    expect(res.content).not.toContain(token);
  });

  it("bash output that prints the file masks the token", async () => {
    const res = await deliver(stdoutTool("bash", readFileSync(configPath, "utf-8")), { command: "cat ~/.lax/config.json" });
    expect(res.content).toContain('"authToken"');
    expect(res.content).not.toContain(token);
  });

  it("a bash timeout shows its partial output and stderr with the token masked", async () => {
    const stderr = `fatal: authentication failed for token ${token}`;
    const row = timeout("Command timed out after 1s.", {
      duration_ms: 1000,
      stderr,
      partial_output: `GET /api/settings\n[stderr]\n${stderr}`,
      recovery: "Increase the `timeout` arg, OR use process_start for long-running commands.",
    });
    const res = await deliver(rowTool("bash", row), { command: "npm run hang" });
    const [header, ...rest] = renderToolResultForModel(res).split("\n");
    expect(header).toMatch(/^\[timeout, /);
    expect(header).toContain('stderr="fatal: authentication failed for token ');
    expect(header).not.toContain(token.slice(0, 12));
    expect(rest.join("\n")).toContain("Partial output:\nGET /api/settings");
    expect(rest.join("\n")).not.toContain(token);
    expect(res.metadata?.secrets_masked).toBe(2);
  });

  it("a bash error shows the stderr it repeats in the header with the token masked", async () => {
    const stderr = `curl: (22) 401 Unauthorized, sent ${token}`;
    const res = await deliver(rowTool("bash", err(stderr, { exit_code: 22, duration_ms: 40, stderr })), { command: "curl -f http://127.0.0.1:7007/api/settings" });
    const [header, ...rest] = renderToolResultForModel(res).split("\n");
    expect(header).toMatch(/^\[error, exit_code=22, /);
    expect(header).toContain('stderr="curl: (22) 401 Unauthorized, sent ');
    expect(header).not.toContain(token.slice(0, 12));
    expect(rest.join("\n")).toContain("curl: (22) 401 Unauthorized, sent ");
    expect(rest.join("\n")).not.toContain(token);
  });

  it("a document whose text carries the token is read back with it masked", async () => {
    const document = documentTools.find((t) => t.name === "document")!;
    const res = await deliver(document, { action: "read", file_path: await docxWith(`Sign in with ${token} if asked.`, scratch) });
    expect(res.content).toContain("Sign in with");
    expect(res.content).not.toContain(token);
  });

  it("the one-click sign-in URL file is read with the token masked", async () => {
    const urlFile = join(scratch, ".startup-url");
    writeFileSync(urlFile, `http://127.0.0.1:7007/?token=${token}`);
    const res = await deliver(readTool, { path: urlFile });
    expect(res.content).toContain("http://127.0.0.1:7007/?token=");
    expect(res.content).not.toContain(token);
  });

  it("a rotated token is masked from the moment it is minted", async () => {
    const fresh = rotateAuthToken();
    try {
      expect(fresh).not.toBe(token);
      const res = await deliver(stdoutTool("process_output", `LAX_AUTH_TOKEN=${fresh}`), {});
      expect(res.content).toContain("LAX_AUTH_TOKEN=");
      expect(res.content).not.toContain(fresh);
    } finally {
      unregisterRedactedSecretValue(fresh);
    }
  });

  it("output with no registered value is delivered byte-identical, with no note", async () => {
    const listing = "src/index.ts:12: const AKIAIOSFODNN7EXAMPLE_fixture = true;";
    const res = await deliver(stdoutTool("grep", listing), { pattern: "fixture" });
    expect(res.content).toBe(listing);
    expect(res.metadata?.secrets_masked).toBeUndefined();
  });
});
