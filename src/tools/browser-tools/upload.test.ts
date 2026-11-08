/**
 * The `upload` action at every site a browser action is registered
 * (registration.test.ts lists the sites for emulate), plus the handler's own
 * refusals: no ref, no path, a missing file, a folder, one of LAX's own
 * data-dir files; the hand-over of the user's own credential-shaped file the
 * gate already asked about; and the canonical path it hands the backend.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The sensitive-page decision reads browserSecrecy; the path resolver still
// needs the real workspaceRoot, so the mock is partial.
vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config.js")>()),
  getRuntimeConfig: () => ({ browserSecrecy: "ask" }),
}));

import { BROWSER_TOOL_DESCRIPTION, BROWSER_TOOL_PARAMETERS, describeBrowserCall } from "./description.js";
import { HUMAN_VERIFICATION_BLOCKED_ACTIONS, PAGE_WRITE_ACTIONS, READ_ONLY_ACTIONS, RESET_ACTIONS, TRACKED_ACTIONS } from "./action-tables.js";
import { handleUpload, uploadPathsOf, UPLOAD_REFUSED_RECOVERY } from "./upload.js";
import { sensitivePageActionDecision } from "../../browser/sensitive-pages.js";
import { deriveAriAction } from "../../tool-execution/ari-action-map.js";
import { egressPayload } from "../../tool-execution/egress-payload.js";
import { TOOL_PATH_ARGS, hasCapability, isReadOnlyCall } from "../../tool-registry.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { FILE_INPUT_NEEDS_HUMAN } from "../../browser/in-app-actions.js";
import type { BrowserBackend } from "../../browser/index.js";

const actionEnum = (BROWSER_TOOL_PARAMETERS.properties.action as { enum: string[] }).enum;

describe("browser action registration: upload", () => {
  it("1. is dispatchable — the action enum offers it, with its parameters declared", () => {
    expect(actionEnum).toContain("upload");
    expect(BROWSER_TOOL_PARAMETERS.properties).toHaveProperty("path");
    expect(BROWSER_TOOL_PARAMETERS.properties).toHaveProperty("paths");
  });

  it("2. is described to the model, and the fill refusal points at it", () => {
    expect(BROWSER_TOOL_DESCRIPTION).toContain("- upload:");
    expect(BROWSER_TOOL_DESCRIPTION).toMatch(/credential or secret file .* approval card .* refused when nobody is watching/i);
    expect(FILE_INPUT_NEEDS_HUMAN).toContain("action 'upload'");
  });

  it("3. is progress-tracked, not a context reset, not read-only, and blocked behind a human-verification challenge", () => {
    expect(TRACKED_ACTIONS.has("upload")).toBe(true);
    expect(RESET_ACTIONS.has("upload")).toBe(false);
    expect(READ_ONLY_ACTIONS.has("upload")).toBe(false);
    expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.has("upload")).toBe(true);
  });

  it("4. is a page write for the kernel and a high-risk mutation on a sensitive page", () => {
    expect(PAGE_WRITE_ACTIONS.has("upload")).toBe(true);
    expect(deriveAriAction("browser", { action: "upload" })).toBe("post");
    expect(sensitivePageActionDecision("https://chase.com/account", "upload").disposition).toBe("approval-required");
    expect(sensitivePageActionDecision("https://example.com/", "upload").disposition).toBe("allow");
  });

  it("5. declares its paths as reads the file gate confines, and they are the call's egress attachments", () => {
    expect(TOOL_PATH_ARGS.browser).toEqual(expect.arrayContaining([
      { arg: "path", action: "read", whenGiven: true },
      { arg: "paths", action: "read", whenGiven: true },
    ]));
    expect(hasCapability("browser", "egress")).toBe(true);
    expect(egressPayload("browser", { action: "upload", ref: 3, path: "C:\\docs\\cv.pdf" }).attachmentPaths).toEqual(["C:\\docs\\cv.pdf"]);
    expect(egressPayload("browser", { action: "upload", ref: 3, paths: ["C:\\a.png", "C:\\b.png"] }).attachmentPaths).toEqual(["C:\\a.png", "C:\\b.png"]);
    // No path, no attachment: a click still reads as carrying nothing.
    expect(egressPayload("browser", { action: "click", ref: 3 }).attachmentPaths).toEqual([]);
    expect(isReadOnlyCall("browser", { action: "upload", ref: 3, path: "C:\\docs\\cv.pdf" })).toBe(false);
  });

  it("6. names the file on the approval card", () => {
    expect(describeBrowserCall({ action: "upload", ref: 3, path: "C:\\docs\\cv.pdf" })).toBe("Upload cv.pdf into the open page, from C:\\docs");
    expect(describeBrowserCall({ action: "upload", ref: 3, paths: ["a.png", "b.png"] })).toBe("Upload a.png, b.png into the open page");
  });
});

describe("uploadPathsOf", () => {
  it("takes paths over path, refuses a malformed list, and reads nothing as nothing", () => {
    expect(uploadPathsOf({ path: "a", paths: ["b", "c"] })).toEqual(["b", "c"]);
    expect(uploadPathsOf({ path: "a", paths: [] })).toEqual(["a"]);
    expect(uploadPathsOf({ path: "  " })).toEqual([]);
    expect(uploadPathsOf({})).toEqual([]);
    expect(uploadPathsOf({ paths: ["a", 3] })).toMatchObject({ error: expect.stringContaining("'paths'") });
    expect(uploadPathsOf({ paths: "a" })).toMatchObject({ error: expect.stringContaining("'paths'") });
  });
});

describe("handleUpload", () => {
  let dir: string;
  let cv: string;
  let priorDataDir: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-upload-"));
    cv = join(dir, "cv.pdf");
    writeFileSync(cv, "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\nplain resume text\n");
    writeFileSync(join(dir, "service-account.json"), JSON.stringify({ type: "service_account", private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n" }));
    writeFileSync(join(dir, "id_rsa"), "not really a key");
    mkdirSync(join(dir, "folder"));
    // The handler stats every file, so the data-dir case needs a real one:
    // a temp data dir holding an auth.json stands in for ~/.lax.
    priorDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = join(dir, "data");
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "auth.json"), "{}");
  });
  afterAll(() => {
    if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = priorDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function backend(): { manager: BrowserBackend; uploadByRef: ReturnType<typeof vi.fn> } {
    const uploadByRef = vi.fn().mockResolvedValue({ ok: true, text: "[3] upload via id=\"f\" — 1 file: cv.pdf" });
    return { manager: { uploadByRef } as unknown as BrowserBackend, uploadByRef };
  }

  it("needs a ref and a path", async () => {
    const { manager, uploadByRef } = backend();
    expect((await handleUpload(manager, { path: cv }, "s")).content).toContain("'ref'");
    expect((await handleUpload(manager, { ref: "x", path: cv }, "s")).content).toContain("must be a number");
    expect((await handleUpload(manager, { ref: 3 }, "s")).content).toContain("Provide 'path'");
    expect(uploadByRef).not.toHaveBeenCalled();
  });

  it("hands the backend the canonical path of a regular file and returns its result", async () => {
    const { manager, uploadByRef } = backend();
    const res = await handleUpload(manager, { ref: 3, path: cv }, "s");
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("[3] upload via");
    expect(uploadByRef).toHaveBeenCalledWith(3, [expect.stringMatching(/cv\.pdf$/)]);
  });

  it("refuses a missing file and a folder before touching the browser", async () => {
    const { manager, uploadByRef } = backend();
    expect((await handleUpload(manager, { ref: 3, path: join(dir, "nope.pdf") }, "s")).content).toContain("no such file");
    expect((await handleUpload(manager, { ref: 3, path: join(dir, "folder") }, "s")).content).toContain("not a regular file");
    expect(uploadByRef).not.toHaveBeenCalled();
  });

  // The user's own credential file reaches this handler only after the egress
  // gate put it to the user as an approval card (an unattended run was refused
  // there), so the re-scan here lets a confirmable finding through — the way
  // http_request treats its own re-scan — and refuses only a hard one.
  it("hands over the user's own credential-shaped file: the gate already asked", async () => {
    const { manager, uploadByRef } = backend();
    for (const file of ["id_rsa", "service-account.json"]) {
      const res = await handleUpload(manager, { ref: 3, path: join(dir, file) }, "s");
      expect(res.status, file).not.toBe("blocked");
      expect(uploadByRef).toHaveBeenLastCalledWith(3, [expect.stringMatching(new RegExp(`${file}$`))]);
    }
  });

  it("refuses one of LAX's own data-dir files outright, alone or in a list, pointing at the human", async () => {
    const { manager, uploadByRef } = backend();
    const own = join(getLaxDir(), "auth.json");
    for (const paths of [[own], [cv, own]]) {
      const res = await handleUpload(manager, { ref: 3, paths }, "s");
      expect(res.status, paths.join()).toBe("blocked");
      expect(res.metadata).toMatchObject({ layer: "egress-guard", recovery: UPLOAD_REFUSED_RECOVERY });
      expect(res.content).toContain("sensitive file");
    }
    expect(uploadByRef).not.toHaveBeenCalled();
  });

  it("relays a backend refusal as an error", async () => {
    const { manager, uploadByRef } = backend();
    uploadByRef.mockResolvedValue({ ok: false, text: "[3] upload failed: no file chooser opened" });
    const res = await handleUpload(manager, { ref: 3, path: cv }, "s");
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no file chooser opened");
  });
});
