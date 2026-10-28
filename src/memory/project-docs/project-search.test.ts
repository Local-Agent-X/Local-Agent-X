// In a project chat, memory_search and the per-turn recall reach that
// project's documents and say which file each passage came from. The project
// is the server's session mapping, never something the model can name, and a
// passage from the user's own folders counts as a private read.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../index.js";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import { setSessionProject, _resetSessionProjectsForTest } from "../../session/project.js";
import { memorySearchTool } from "../tools/search/memory-search.js";
import { autoSearchContext, renderRecalledMemory } from "../auto-search-context.js";
import { hasPrivateReads, clearPrivateContent } from "../../data-lineage/private-content.js";
import { buildContextBlock } from "../context.js";
import { indexProjectDocs } from "./indexer.js";
import { projectDocsDir } from "./folders.js";

const PID = "proj-search-a";
const OTHER = "proj-search-b";
let root: string;
let memory: MemoryIndex;
let savedConfig: ReturnType<typeof getRuntimeConfig>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lax-project-search-"));
  mkdirSync(join(root, "data", "memory", "bank", "entities"), { recursive: true });
  savedConfig = getRuntimeConfig();
  setRuntimeConfig({ ...savedConfig, workspace: join(root, "workspace") });
  memory = new MemoryIndex(join(root, "data"));
  _resetSessionProjectsForTest();
  mkdirSync(projectDocsDir(PID), { recursive: true });
  writeFileSync(join(projectDocsDir(PID), "pricing.md"), "The enterprise tier renews at an eighteen percent uplift.\n");
  await indexProjectDocs(memory, { id: PID });
  await indexProjectDocs(memory, { id: OTHER });
});

afterEach(() => {
  setRuntimeConfig(savedConfig);
  try { memory.close(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

const runSearch = async (sessionId: string, extra: Record<string, unknown> = {}) =>
  String((await memorySearchTool(memory).execute({ query: "enterprise tier renews uplift", ...extra, _sessionId: sessionId })).content);

describe("memory_search in a project chat", () => {
  it("returns the project's passage with its file", async () => {
    setSessionProject("s-a", PID);
    const out = await runSearch("s-a");
    expect(out).toContain("source=project-doc");
    expect(out).toContain(`file=${JSON.stringify(join(projectDocsDir(PID), "pricing.md"))}`);
    expect(out).toContain("eighteen percent");
  });

  it("never returns them to another project's chat or a chat with no project, whatever the model passes", async () => {
    setSessionProject("s-b", OTHER);
    for (const extra of [{}, { project_id: PID }, { project: PID }, { sources: ["project-doc"] }]) {
      expect(await runSearch("s-b", extra)).not.toContain("eighteen percent");
      expect(await runSearch("s-none", extra)).not.toContain("eighteen percent");
    }
  });
});

describe("the per-turn recall in a project chat", () => {
  it("can carry a project passage, labelled untrusted and with its file", async () => {
    const recalled = await autoSearchContext(memory, "what uplift does the enterprise tier renew at", { sessionId: "s-a", projectId: PID });
    const text = recalled ? renderRecalledMemory(recalled) : "";
    expect(text).toContain("project-doc");
    expect(text).toContain("trust: untrusted");
    expect(text).toContain(`file: ${join(projectDocsDir(PID), "pricing.md")}`);
    const none = await autoSearchContext(memory, "what uplift does the enterprise tier renew at", { sessionId: "s-b", projectId: OTHER });
    expect(none ? renderRecalledMemory(none) : "").not.toContain("eighteen percent");
  });
});

describe("the documents folder in context", () => {
  it("is named for a project chat", async () => {
    const block = await buildContextBlock(memory, { skipDailyLog: true, projectId: PID });
    expect(block).toContain(`This project's documents folder: ${projectDocsDir(PID)}`);
  });
});

describe("a passage from the user's own folders", () => {
  it("is recorded as a private read, as opening the file would be; the project's own folder is not", async () => {
    const linked = join(homedir(), "Documents", "ClientX");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, "contract.md"), "The ClientX contract sets a ninety day termination notice period.\n");
    await indexProjectDocs(memory, { id: PID, workspace: linked });
    setSessionProject("s-priv", PID);
    try {
      await runSearch("s-priv");
      expect(hasPrivateReads("s-priv")).toBe(false);
      await memorySearchTool(memory).execute({ query: "ClientX contract termination notice", _sessionId: "s-priv" });
      expect(hasPrivateReads("s-priv")).toBe(true);
    } finally {
      clearPrivateContent("s-priv");
      rmSync(linked, { recursive: true, force: true });
    }
  });
});
