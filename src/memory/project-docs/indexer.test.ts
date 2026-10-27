// A project's documents become searchable for that project's chats, follow
// the files as they change, and never surface what the agent may not read.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../index.js";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { indexProjectDocs, removeProjectDocs, indexedProjectIds, MAX_DOC_FILE_BYTES } from "./indexer.js";
import { projectDocsDir } from "./folders.js";

const PID = "proj-docs-test1";
let root: string;
let memory: MemoryIndex;
let savedConfig: ReturnType<typeof getRuntimeConfig>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-project-docs-"));
  mkdirSync(join(root, "data", "memory", "bank", "entities"), { recursive: true });
  savedConfig = getRuntimeConfig();
  setRuntimeConfig({ ...savedConfig, workspace: join(root, "workspace") });
  memory = new MemoryIndex(join(root, "data"));
});

afterEach(() => {
  setRuntimeConfig(savedConfig);
  try { memory.close(); } catch {}
  try { rmSync(join(getLaxDir(), "security.json"), { force: true }); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

const search = (q: string, projectId?: string) => memory.search(q, { projectId, minScore: 0.01 });
const docsDir = () => projectDocsDir(PID);

describe("a project's documents folder", () => {
  it("is created for the project inside the agent's workspace and indexed, searchable only for that project", async () => {
    const report0 = await indexProjectDocs(memory, { id: PID });
    expect(existsSync(docsDir())).toBe(true);
    expect(docsDir().startsWith(join(root, "workspace"))).toBe(true);
    expect(report0.indexed).toBe(0);

    writeFileSync(join(docsDir(), "pricing.md"), "# Pricing\n\nThe enterprise tier renews at 18 percent uplift.\n");
    mkdirSync(join(docsDir(), "notes"));
    writeFileSync(join(docsDir(), "notes", "kickoff.txt"), "Kickoff: the client wants weekly invoicing.\n");
    const report = await indexProjectDocs(memory, { id: PID });
    expect(report.indexed).toBe(2);

    const hits = await search("enterprise tier renews uplift", PID);
    const hit = hits.find((h) => h.source === "project-doc");
    expect(hit?.path).toBe(`project/${PID}/docs/pricing.md`);
    expect(hit?.metadata?.file_path).toBe(join(docsDir(), "pricing.md"));
    expect(hit?.provenance?.trust_status).toBe("untrusted");
    expect((await search("enterprise tier renews uplift")).some((h) => h.source === "project-doc")).toBe(false);
    expect((await search("enterprise tier renews uplift", "proj-other")).some((h) => h.source === "project-doc")).toBe(false);
  });

  it("re-reads only changed files, and drops a deleted file and a deleted project", async () => {
    const file = join(docsDir(), "pricing.md");
    await indexProjectDocs(memory, { id: PID });
    writeFileSync(file, "The enterprise tier renews at 18 percent uplift.\n");
    writeFileSync(join(docsDir(), "other.md"), "Unrelated memo about parking.\n");
    await indexProjectDocs(memory, { id: PID });

    expect(await indexProjectDocs(memory, { id: PID })).toMatchObject({ indexed: 0, unchanged: 2, removed: 0 });

    writeFileSync(file, "The enterprise tier now renews at 12 percent uplift.\n");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(await indexProjectDocs(memory, { id: PID })).toMatchObject({ indexed: 1, unchanged: 1 });
    expect((await search("renews 12 percent", PID))[0]?.snippet).toContain("12 percent");

    rmSync(file);
    expect(await indexProjectDocs(memory, { id: PID })).toMatchObject({ removed: 1 });
    expect((await search("enterprise tier renews", PID)).some((h) => h.path.endsWith("pricing.md"))).toBe(false);

    expect(indexedProjectIds(memory)).toEqual([PID]);
    expect(removeProjectDocs(memory, PID)).toBe(1);
    expect(indexedProjectIds(memory)).toEqual([]);
  });

  it("skips what is not a document, credentials, dot-folders, symlinks, dependency folders and oversized files", async () => {
    await indexProjectDocs(memory, { id: PID });
    writeFileSync(join(docsDir(), "app.exe"), "MZ binary needle");
    writeFileSync(join(docsDir(), ".env"), "API_KEY=needle");
    writeFileSync(join(docsDir(), "id_rsa"), "needle");
    mkdirSync(join(docsDir(), ".git"));
    writeFileSync(join(docsDir(), ".git", "notes.md"), "needle");
    mkdirSync(join(docsDir(), "node_modules"));
    writeFileSync(join(docsDir(), "node_modules", "readme.md"), "needle");
    writeFileSync(join(docsDir(), "huge.txt"), Buffer.alloc(MAX_DOC_FILE_BYTES + 1, "a"));
    const report = await indexProjectDocs(memory, { id: PID });
    expect(report.indexed).toBe(0);
    expect(report.skipped.some((s) => s.includes("huge.txt"))).toBe(true);
  });

  it("indexes a folder the user set as well, and a code folder not at all", async () => {
    const linked = join(root, "client-files");
    mkdirSync(linked);
    writeFileSync(join(linked, "brief.md"), "The client brief asks for a spring launch.\n");
    await indexProjectDocs(memory, { id: PID, workspace: linked });
    expect((await search("client brief spring launch", PID)).find((h) => h.source === "project-doc")?.path)
      .toBe(`project/${PID}/linked/brief.md`);

    const code = await indexProjectDocs(memory, { id: "proj-code1", workspace: linked, codeFolder: true });
    expect(code.indexed).toBe(0);
    expect(existsSync(projectDocsDir("proj-code1"))).toBe(false);
  });

  it("leaves out a set folder the agent's file access does not reach", async () => {
    writeFileSync(join(getLaxDir(), "security.json"), JSON.stringify({ fileAccessMode: "workspace" }));
    const linked = join(root, "outside-the-workspace");
    mkdirSync(linked);
    writeFileSync(join(linked, "secret-plan.md"), "The outside plan mentions a merger.\n");
    mkdirSync(docsDir(), { recursive: true });
    writeFileSync(join(docsDir(), "inside.md"), "Inside note about the merger timeline.\n");
    const report = await indexProjectDocs(memory, { id: PID, workspace: linked });
    expect(report.indexed).toBe(1);
    expect(report.skipped.some((s) => s.includes("outside-the-workspace"))).toBe(true);
    expect((await search("merger", PID)).some((h) => h.path.includes("/linked/"))).toBe(false);
  });
});
