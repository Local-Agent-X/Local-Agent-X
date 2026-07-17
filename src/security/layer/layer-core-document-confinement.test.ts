import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TOOL_PATH_ARGS } from "../../tool-registry.js";
import { evaluateFileAccess } from "./file-access.js";
import { SecurityLayer } from "./layer-core.js";

const WORKSPACE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "lax-ws-")));
const WORKSPACE = join(WORKSPACE_ROOT, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
afterAll(() => rmSync(WORKSPACE_ROOT, { recursive: true, force: true }));


describe("structured-document file-access confinement (TOOL_PATH_ARGS)", () => {
  const ws = resolve(WORKSPACE);
  // An absolute path outside the project root AND outside ~/.lax — blocked in
  // workspace mode. The filename mirrors the real breach report. Anchored to
  // tmpdir (not the suite's LAX dir, which is only set in beforeAll).
  const OUTDIR = resolve(tmpdir(), "lax-confine-test");
  const OUTSIDE = resolve(OUTDIR, "2024 May order.xlsx");
  const INSIDE = resolve(ws, "data.xlsx");

  it("workspace mode: spreadsheet read OUTSIDE the project is blocked (the breach)", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const d = sec.evaluate({ toolName: "spreadsheet", args: { action: "read", file_path: OUTSIDE }, sessionId: "t" });
    expect(d.allowed).toBe(false);
  });

  it("workspace mode: spreadsheet read INSIDE the workspace is still allowed", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const d = sec.evaluate({ toolName: "spreadsheet", args: { action: "read", file_path: INSIDE }, sessionId: "t" });
    expect(d.allowed).toBe(true);
  });

  it("spreadsheet read verdict == evaluateFileAccess(read) — same gate, not a parallel one", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const expected = evaluateFileAccess(ws, "workspace", () => false, "read", OUTSIDE);
    const d = sec.evaluate({ toolName: "spreadsheet", args: { action: "read", file_path: OUTSIDE }, sessionId: "t" });
    expect(d.allowed).toBe(expected.allowed);
    expect(d.reason).toBe(expected.reason);
  });

  it("workspace mode: document create WRITE outside the workspace is blocked", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const d = sec.evaluate({
      toolName: "document",
      args: { action: "create", file_path: resolve(OUTDIR, "out.docx"), content: "x" },
      sessionId: "t",
    });
    expect(d.allowed).toBe(false);
  });

  it("pdf merge: an out-of-bounds member of the files[] JSON array blocks the call", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const d = sec.evaluate({
      toolName: "pdf",
      args: { action: "merge", files: JSON.stringify([resolve(ws, "a.pdf"), OUTSIDE]), output_path: resolve(ws, "merged.pdf") },
      sessionId: "t",
    });
    expect(d.allowed).toBe(false);
  });

  it("collapsed family tools FAIL CLOSED on an action with no declared path gating", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    // Even an in-workspace path is denied when the action isn't declared in
    // any forActions list — adding a tool action without updating the policy
    // table must block, never bypass.
    const d = sec.evaluate({ toolName: "spreadsheet", args: { action: "explode", file_path: INSIDE }, sessionId: "t" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("no declared path gating");
  });

  it("ocr / view_image (path arg) are confined outside the workspace", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    for (const toolName of ["ocr", "view_image"]) {
      const d = sec.evaluate({ toolName, args: { path: resolve(OUTDIR, "img.png") }, sessionId: "t" });
      expect(d.allowed, toolName).toBe(false);
    }
  });

  // COVERAGE: no declared file sink may bypass workspace confinement. For every
  // tool in TOOL_PATH_ARGS, an out-of-bounds absolute path on EACH declared arg
  // must be blocked in workspace mode. Fails the build the moment a tool
  // declares a path arg the gate doesn't actually enforce.
  it("every TOOL_PATH_ARGS arg blocks an out-of-bounds path in workspace mode", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    for (const [toolName, specs] of Object.entries(TOOL_PATH_ARGS)) {
      for (const spec of specs) {
        const val = spec.json ? JSON.stringify([OUTSIDE]) : OUTSIDE;
        // Conditional specs (collapsed family tools) need the declaring action
        // present, or the fail-closed undeclared-action deny fires instead of
        // the file gate this test exercises.
        const action = spec.forActions?.[0];
        const d = sec.evaluate({ toolName, args: { ...(action ? { action } : {}), [spec.arg]: val }, sessionId: "t" });
        expect(d.allowed, `${toolName}.${spec.arg} must be confined`).toBe(false);
      }
    }
  });

  // Guard against silent regression: the known office/vision sinks must stay
  // declared. Removing a declaration (re-opening the bypass) fails here.
  it("known office/vision file sinks are declared in TOOL_PATH_ARGS", () => {
    for (const t of ["spreadsheet", "document", "presentation", "pdf", "ocr", "view_image", "send_video"]) {
      expect(TOOL_PATH_ARGS[t], `${t} must declare pathArgs`).toBeTruthy();
    }
    // Every office action must appear in some forActions list (or the family
    // must declare an unconditional spec) — the fail-closed deny covers the
    // rest, but a missing WRITE action would over-block, so pin the table.
    const expectedActions: Record<string, string[]> = {
      spreadsheet: ["read", "write", "edit", "query"],
      document: ["create", "read", "edit", "template"],
      presentation: ["create", "add_slide", "from_outline", "edit"],
      pdf: ["read", "create", "merge", "extract_tables"],
    };
    for (const [tool, actions] of Object.entries(expectedActions)) {
      const specs = TOOL_PATH_ARGS[tool] ?? [];
      for (const a of actions) {
        const covered = specs.some((s) => !s.forActions || s.forActions.includes(a));
        expect(covered, `${tool}.${a} must be covered by a pathArgs spec`).toBe(true);
      }
    }
  });
});
// On Windows with OneDrive "Known Folder Move", the user's real Documents lives
// at %OneDrive%\Documents, not ~/Documents — so common mode (which is supposed
// to grant the user's own folders) was blocking their actual Documents and
// forcing them all the way to unrestricted. Common mode must recognize the
// OneDrive-redirected folders.
describe("common mode recognizes OneDrive-redirected user folders (KFM)", () => {
  const HOME = resolve("/kfm-home");
  const ONEDRIVE = resolve("/kfm-home/OneDrive");
  const ws = resolve(HOME, "project", "workspace");
  let saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, OneDrive: process.env.OneDrive };
    process.env.HOME = HOME;
    process.env.USERPROFILE = HOME;
    process.env.OneDrive = ONEDRIVE;
  });
  afterAll(() => {
    for (const k of ["HOME", "USERPROFILE", "OneDrive"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("common: a read under %OneDrive%\\Documents is allowed", () => {
    const p = resolve(ONEDRIVE, "Documents", "2024 May order.xlsx");
    expect(evaluateFileAccess(ws, "common", () => false, "read", p).allowed).toBe(true);
  });

  it("common: the literal ~/Documents still works (non-OneDrive folder)", () => {
    const p = resolve(HOME, "Documents", "notes.txt");
    expect(evaluateFileAccess(ws, "common", () => false, "read", p).allowed).toBe(true);
  });

  it("common: a path outside both home and OneDrive is still blocked", () => {
    const p = resolve("/some/other/root/secret.txt");
    expect(evaluateFileAccess(ws, "common", () => false, "read", p).allowed).toBe(false);
  });

  it("workspace mode: OneDrive Documents stays blocked (project only)", () => {
    const p = resolve(ONEDRIVE, "Documents", "x.xlsx");
    expect(evaluateFileAccess(ws, "workspace", () => false, "read", p).allowed).toBe(false);
  });
});

// "Workspace Only" must mean the workspace FOLDER (and its children), not the
// folder's PARENT — otherwise pointing the workspace at C:\Users\me\workspace
// would expose all of C:\Users\me. Common mode stays broader (project + user
// dirs) by design.
describe("workspace mode confines to the workspace folder, not its parent", () => {
  const ws = resolve(WORKSPACE); // <cwd>/workspace — parent is the project root

  it("allows reads anywhere UNDER the workspace", () => {
    const p = resolve(ws, "apps", "demo", "index.html");
    expect(evaluateFileAccess(ws, "workspace", () => false, "read", p).allowed).toBe(true);
  });

  it("blocks a read in the workspace's PARENT (project root) — the tightening", () => {
    const p = resolve(ws, "..", "package.json");
    expect(evaluateFileAccess(ws, "workspace", () => false, "read", p).allowed).toBe(false);
  });

  it("common mode still allows the project root (broader by design)", () => {
    const p = resolve(ws, "..", "package.json");
    expect(evaluateFileAccess(ws, "common", () => false, "read", p).allowed).toBe(true);
  });
});
