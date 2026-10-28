// "Add files" on a sidebar project: documents land in the project's own
// folder under the names the user gave them, nothing else does, and the
// listing shows what is there.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import { handleProjectFileRoutes, safeDocName } from "./project-files.js";
import { projectDocsDir } from "../../memory/project-docs/folders.js";
import type { ServerContext } from "../../server-context.js";

vi.mock("../../chat-ws/index.js", () => ({ broadcastAll: vi.fn() }));

const BOUNDARY = "lax-test-boundary";
let root: string;
let savedConfig: ReturnType<typeof getRuntimeConfig>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-project-files-"));
  savedConfig = getRuntimeConfig();
  setRuntimeConfig({ ...savedConfig, workspace: join(root, "workspace") });
});

afterEach(() => {
  setRuntimeConfig(savedConfig);
  rmSync(root, { recursive: true, force: true });
});

const projects: Record<string, { id: string; codeFolder?: boolean }> = {
  "proj-files-a": { id: "proj-files-a" },
  "proj-code-a": { id: "proj-code-a", codeFolder: true },
};
const ctx = {
  projectStore: { get: (id: string) => projects[id] ?? null },
  config: { maxUploadBytes: 10 * 1024 * 1024 },
} as unknown as ServerContext;

function multipart(files: Array<[string, string]>): Buffer {
  const parts = files.map(([name, body]) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${body}\r\n`);
  return Buffer.from(parts.join("") + `--${BOUNDARY}--\r\n`);
}

async function call(method: string, path: string, body?: Buffer): Promise<{ status: number; data: Record<string, unknown> }> {
  const req = Readable.from(body ? [body] : []) as unknown as IncomingMessage;
  req.headers = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };
  let status = 0;
  let text = "";
  const res = {
    writeHead: (s: number) => { status = s; return res; },
    setHeader: () => res,
    end: (b?: string) => { text = b ?? ""; },
  } as unknown as ServerResponse;
  const handled = await handleProjectFileRoutes(method, new URL(`http://x${path}`), req, res, ctx, "admin" as never);
  expect(handled).toBe(true);
  return { status, data: JSON.parse(text || "{}") };
}

describe("adding files to a project", () => {
  it("writes documents into the project's folder under their own names, a clash getting a number", async () => {
    const dir = projectDocsDir("proj-files-a");
    const first = await call("POST", "/api/projects/proj-files-a/files", multipart([["Q3 plan.md", "# Q3"], ["notes.txt", "hello"]]));
    expect(first.status).toBe(200);
    expect(first.data.added).toEqual(["Q3 plan.md", "notes.txt"]);
    expect(readFileSync(join(dir, "Q3 plan.md"), "utf-8")).toBe("# Q3");

    const again = await call("POST", "/api/projects/proj-files-a/files", multipart([["Q3 plan.md", "# Q3 v2"]]));
    expect(again.data.added).toEqual(["Q3 plan (2).md"]);
    expect(readFileSync(join(dir, "Q3 plan.md"), "utf-8")).toBe("# Q3");
  });

  it("refuses what is not a document and never writes outside the folder", async () => {
    const out = await call("POST", "/api/projects/proj-files-a/files", multipart([["run.exe", "MZ"], ["../../escape.md", "x"], [".env", "K=V"]]));
    expect(out.data.refused).toEqual(["run.exe", ".env"]);
    expect(out.data.added).toEqual(["escape.md"]);
    expect(existsSync(join(projectDocsDir("proj-files-a"), "escape.md"))).toBe(true);
    expect(existsSync(join(root, "escape.md"))).toBe(false);
  });

  it("lists the folder, and has nothing for a code folder or an unknown project", async () => {
    await call("POST", "/api/projects/proj-files-a/files", multipart([["brief.pdf", "%PDF-1.4"]]));
    const list = await call("GET", "/api/projects/proj-files-a/files");
    expect(list.data.folder).toBe(projectDocsDir("proj-files-a"));
    expect(list.data.files).toEqual([expect.objectContaining({ name: "brief.pdf" })]);
    expect((await call("GET", "/api/projects/proj-code-a/files")).status).toBe(404);
    expect((await call("POST", "/api/projects/proj-nope/files", multipart([["a.md", "x"]]))).status).toBe(404);
  });
});

describe("safeDocName", () => {
  it("keeps the user's name but drops folders, reserved characters and a leading dot", () => {
    expect(safeDocName("Q3 plan.md")).toBe("Q3 plan.md");
    expect(safeDocName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(safeDocName("a<b>:c?.txt")).toBe("a_b__c_.txt");
    expect(safeDocName("...hidden.md")).toBe("hidden.md");
    expect(safeDocName("")).toBe("document");
  });
});
