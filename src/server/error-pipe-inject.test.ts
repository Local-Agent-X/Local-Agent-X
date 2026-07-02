import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { phoneErrorPipeScript, _resetErrorPipeCache } from "./error-pipe-inject.js";

const realPublicDir = resolve(import.meta.dirname, "../../public");

beforeEach(() => _resetErrorPipeCache());

describe("phoneErrorPipeScript", () => {
  it("wraps the real capture core with a fetch emitter targeting the app's ingress", () => {
    const script = phoneErrorPipeScript(realPublicDir, "todo-list");
    expect(script.startsWith("<script>")).toBe(true);
    expect(script.endsWith("</script>")).toBe(true);
    expect(script).toContain("function __laxInstallErrorPipe");
    expect(script).toContain("securitypolicyviolation"); // capture core really inlined
    expect(script).toContain('"/api/apps/todo-list/runtime-error"');
    // The core must stay verbatim-injectable: a stray </script> would
    // terminate the wrapper tag mid-core.
    expect(script.slice("<script>".length, -"</script>".length)).not.toContain("</script>");
  });

  it("returns empty for an appId that could break out of the URL/script", () => {
    expect(phoneErrorPipeScript(realPublicDir, 'x"};alert(1);//')).toBe("");
    expect(phoneErrorPipeScript(realPublicDir, "a/b")).toBe("");
  });

  it("degrades to empty when the core file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-error-pipe-"));
    mkdirSync(join(dir, "js"), { recursive: true });
    expect(phoneErrorPipeScript(dir, "todo-list")).toBe("");
    // and stays consistent once cached
    writeFileSync(join(dir, "js", "apps-error-pipe-core.js"), "function __laxInstallErrorPipe(){}");
    expect(phoneErrorPipeScript(dir, "todo-list")).toBe("");
  });
});
