// The ari_* bridges run the kernel's own executors — raw disk and network
// I/O — but were classed `internal`, so the dispatch gate never asked the
// kernel's policy engine about them and the bridge ran the executor with no
// grant (red team 2026-10-13, B4). They are now file- and http-class rows
// judged like read, write and http_request.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ariActionOf, hasCapability, TOOLS } from "../tool-registry.js";
import { ariEvaluate, shouldGateInKernel, startAriKernel, stopAriKernel } from "../ari-kernel/index.js";

describe("the kernel bridges are gated tools", () => {
  it("ari_file is file-class: read by default, write on action write", () => {
    expect(TOOLS.ari_file.kernel).toBe("file");
    expect(shouldGateInKernel("ari_file")).toBe(true);
    expect(ariActionOf("ari_file", { action: "read", path: "x" })).toBe("read");
    expect(ariActionOf("ari_file", { path: "x" })).toBe("read");
    expect(ariActionOf("ari_file", { action: "WRITE", path: "x", content: "y" })).toBe("write");
  });

  it("ari_http is http-class: its action is the verb, and it is egress", () => {
    expect(TOOLS.ari_http.kernel).toBe("http");
    expect(shouldGateInKernel("ari_http")).toBe(true);
    expect(hasCapability("ari_http", "egress")).toBe(true);
    expect(ariActionOf("ari_http", { url: "https://x.example" })).toBe("get");
    for (const action of ["post", "put", "patch", "delete"]) expect(ariActionOf("ari_http", { action, url: "https://x.example" })).toBe(action);
  });
});

describe("the kernel judges a bridge call like its native twin", () => {
  let dir = "";
  const prevKey = process.env.LAX_AUDIT_KEY;
  beforeEach(async () => {
    process.env.LAX_AUDIT_KEY = "test-ari-bridge-kernel-action-key-0123456789";
    dir = mkdtempSync(join(tmpdir(), "lax-ari-bridge-"));
    await startAriKernel(join(dir, "audit.db"), "workspace-assistant", true);
  });
  afterEach(() => {
    stopAriKernel();
    rmSync(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  it("a clean ari_http post is allowed, a tainted one denied, a tainted get allowed", async () => {
    const args = { action: "post", url: "https://api.example/x", body: "{}" };
    expect((await ariEvaluate("ari_http", ariActionOf("ari_http", args), args, [])).allowed).toBe(true);
    expect((await ariEvaluate("ari_http", ariActionOf("ari_http", args), args, ["rag"])).allowed).toBe(false);
    const get = { action: "get", url: "https://api.example/x" };
    expect((await ariEvaluate("ari_http", ariActionOf("ari_http", get), get, ["rag"])).allowed).toBe(true);
  });

  it("an ari_file read and write are allowed under the host preset", async () => {
    const read = { action: "read", path: join(dir, "a.txt") };
    expect((await ariEvaluate("ari_file", ariActionOf("ari_file", read), read, [])).allowed).toBe(true);
    const write = { action: "write", path: join(dir, "a.txt"), content: "x" };
    expect((await ariEvaluate("ari_file", ariActionOf("ari_file", write), write, [])).allowed).toBe(true);
  });
});
