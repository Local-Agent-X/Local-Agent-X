// A kernel deny is a verdict, not an engine error.
//
// The kernel delivered a policy deny by throwing ToolCallDeniedError (it now
// returns one from Firewall.judge), and ariEvaluate's catch used to treat every
// throw as "ARI error": blocked when the
// kernel is required, fail-open when it is optional (ariRequired=false, i.e.
// LAX_ARI_REQUIRED=0). So with an optional kernel a web-tainted email_send or
// a tainted shell command came back `allowed: true`. A deny must block in both
// modes; only a genuine engine fault keeps the documented fail-open.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAriKernel, stopAriKernel } from "./lifecycle.js";
import { ariEvaluate } from "./evaluate.js";

const EMAIL = { to: "someone@example.com", subject: "x", body: "hello" };

describe("ariEvaluate: a thrown kernel deny blocks in every mode", () => {
  let dir: string;
  const prevKey = process.env.LAX_AUDIT_KEY;

  beforeEach(() => {
    // Fixed key so the test never reads/creates the real ~/.lax/audit-key.
    process.env.LAX_AUDIT_KEY = "test-ari-evaluate-key-0123456789abcdef";
    dir = mkdtempSync(join(tmpdir(), "lax-ari-evaluate-"));
  });

  afterEach(() => {
    stopAriKernel();
    rmSync(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  it("blocks a tainted outbound write when the kernel is optional", async () => {
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", false);
    const r = await ariEvaluate("email_send", "post", EMAIL, ["web"]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Outbound HTTP writes blocked/);
    expect(r.reason).not.toMatch(/evaluation error|fail-open/);
  });

  it("blocks a tainted shell command when the kernel is optional", async () => {
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", false);
    const r = await ariEvaluate("bash", "exec", { command: "echo hi" }, ["web"]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/untrusted input/);
  });

  it("keeps the documented fail-open for a genuine engine fault when optional", async () => {
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", false);
    // A taint source outside the kernel's enum is rejected by its request
    // schema (a ZodError, not a deny).
    const r = await ariEvaluate("email_send", "post", EMAIL, ["not-a-kernel-source"]);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/fail-open/);
  });

  it("names the deny itself, not an evaluation error, when the kernel is required", async () => {
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
    const r = await ariEvaluate("email_send", "post", EMAIL, ["web"]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/^\[ARI kernel\] Tool call denied: Outbound HTTP writes blocked/);
  });

  it("still allows a clean call in both modes", async () => {
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", false);
    expect((await ariEvaluate("email_send", "post", EMAIL, [])).allowed).toBe(true);
  });
});
