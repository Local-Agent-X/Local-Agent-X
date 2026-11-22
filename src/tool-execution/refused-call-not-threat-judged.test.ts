// A call another layer refuses before it runs sent nothing, so the threat
// engine must not judge it as exfiltration. It did, and put "type /approve"
// over the real refusal: the user typed /approve, which changed nothing, and the
// retry met the egress card the threat message had hidden. One download took
// two approvals (2026-11-22).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreatEngine } from "../threat/threat-engine.js";
import { SecurityLayer } from "../security/index.js";
import { dispatchOne } from "./dispatch-one.test-helper.js";
import { createHttpRequestTool } from "../tools/http-request.js";
import { startAriKernel, stopAriKernel } from "../ari-kernel/lifecycle.js";

const SESSION = "refused-call-threat-test";
// Build 2's download: a random-looking id the threat engine reads as a secret.
const ARTIFACT = "https://expo.dev/artifacts/eas/c5KZw55FZZLrKuBrdPoCA4Yp7cOfpPUPIgj8qWbJZqM.apk";

let dir: string;
const prevDir = process.env.LAX_DATA_DIR;
const prevKey = process.env.LAX_AUDIT_KEY;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lax-refused-call-"));
  process.env.LAX_DATA_DIR = dir;
  process.env.LAX_AUDIT_KEY = "test-refused-call-key-0123456789ab";
  await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
});
afterAll(() => {
  stopAriKernel();
  if (prevDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDir;
  if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY; else process.env.LAX_AUDIT_KEY = prevKey;
  rmSync(dir, { recursive: true, force: true });
});

let ran = 0;
const tool = { ...createHttpRequestTool(), execute: async () => { ran += 1; return { content: "sent" }; } };

describe("a call refused before it runs", () => {
  it("keeps the refusal that stopped it, and the threat engine neither blocks nor scores it", async () => {
    const engine = new ThreatEngine(join(dir, "threat"), SESSION);
    const result = await dispatchOne(
      { id: "c1", name: "http_request", args: { url: ARTIFACT, save_to: join(tmpdir(), "outside-the-workspace", "app.apk") } },
      { toolMap: new Map([["http_request", tool]]), security: new SecurityLayer(join(dir, "workspace"), "workspace"), threatEngine: engine, sessionId: SESSION, callContext: "api" },
    );

    expect(ran).toBe(0);
    expect(result.status).toBe("blocked");
    expect(result.metadata?.layer).toBe("security");
    expect(result.content).not.toContain("/approve");
    expect(engine.isRestricted()).toBe(false);
    expect(engine.scorer.getRawLoad()).toBe(0);
    expect(engine.audit.getRecent(50).map((e) => e.event)).not.toContain("exfiltration_detected");
  });
});
