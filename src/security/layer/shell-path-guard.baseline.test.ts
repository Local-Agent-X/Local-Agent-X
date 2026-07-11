import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLockedBaselineMutation, evaluateShellCommandAndPaths } from "./shell-path-guard.js";

// A workspace with two apps: `foo` was harness-scaffolded (has a manifest that
// locks its baseline), `bare` was not (no manifest — must stay fully editable).
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "lax-baseline-")));
const WORKSPACE = join(ROOT, "workspace");
const FOO = join(WORKSPACE, "apps", "foo");
const BARE = join(WORKSPACE, "apps", "bare");
mkdirSync(join(FOO, ".lax"), { recursive: true });
mkdirSync(BARE, { recursive: true });
writeFileSync(
  join(FOO, ".lax", "scaffold.json"),
  JSON.stringify({ ownedPaths: ["package.json", "vite.config.ts", "tsconfig.json"] }),
  "utf-8",
);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const blocked = (cmd: string) => detectLockedBaselineMutation(cmd, WORKSPACE) !== null;

describe("detectLockedBaselineMutation", () => {
  it("blocks an absolute redirect over a locked baseline file", () => {
    expect(blocked(`echo x > ${join(FOO, "package.json")}`)).toBe(true);
  });

  it("blocks a workspace-relative redirect over a locked baseline file", () => {
    expect(blocked("printf x > workspace/apps/foo/vite.config.ts")).toBe(true);
  });

  it("blocks a `cd <app> && redirect` clobber (relative target under the app cwd)", () => {
    expect(blocked("cd apps/foo && echo x > package.json")).toBe(true);
    expect(blocked(`cd ${FOO} && echo x > tsconfig.json`)).toBe(true);
  });

  it("blocks cp/mv/rm/tee over a locked baseline file", () => {
    expect(blocked("cp /tmp/x workspace/apps/foo/package.json")).toBe(true);
    expect(blocked("mv /tmp/x workspace/apps/foo/vite.config.ts")).toBe(true);
    expect(blocked("rm workspace/apps/foo/tsconfig.json")).toBe(true);
    expect(blocked("echo x | tee workspace/apps/foo/package.json")).toBe(true);
  });

  it("ALLOWS writing app code under src/ (not an owned baseline path)", () => {
    expect(blocked("echo x > workspace/apps/foo/src/App.tsx")).toBe(false);
    expect(blocked("cd apps/foo && echo x > src/main.tsx")).toBe(false);
  });

  it("ALLOWS clobbering an app with NO scaffold manifest (lock is manifest-gated)", () => {
    expect(blocked("echo x > workspace/apps/bare/package.json")).toBe(false);
    expect(blocked(`echo x > ${join(BARE, "package.json")}`)).toBe(false);
  });

  it("ignores commands with no write target and non-app writes", () => {
    expect(blocked("npm install react-router")).toBe(false);
    expect(blocked("echo hi > notes.txt")).toBe(false);
    expect(blocked("cat workspace/apps/foo/package.json")).toBe(false); // read, not write
  });
});

describe("evaluateShellCommandAndPaths — baseline lock is mode-independent", () => {
  // unrestricted mode makes evaluateShellPaths a no-op; the baseline lock must
  // still fire, proving it isn't riding the file-access boundary.
  const ctx = {
    workspace: WORKSPACE,
    fileAccessMode: "unrestricted" as const,
    inlineEvalPolicy: "allow" as const,
    allowedPathCheck: () => true,
  };

  it("blocks a baseline clobber even in unrestricted mode", () => {
    const d = evaluateShellCommandAndPaths("printf x > workspace/apps/foo/package.json", ctx);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/baseline/i);
  });

  it("allows the same write to a src/ file", () => {
    expect(evaluateShellCommandAndPaths("printf x > workspace/apps/foo/src/App.tsx", ctx).allowed).toBe(true);
  });
});
