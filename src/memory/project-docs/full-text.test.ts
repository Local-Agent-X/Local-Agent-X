// A project small enough to fit gets its documents in full: while every
// document of the chat's project fits in a quarter of the model's window, the
// prompt carries all of them word for word; past that it carries none and the
// agent works from search. The text comes from the index, never a re-read.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../index.js";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import { lookupContextWindow } from "../../context-manager/model-windows.js";
import { setSessionProject, _resetSessionProjectsForTest } from "../../session/project.js";
import { indexProjectDocs } from "./indexer.js";
import { projectDocsDir } from "./folders.js";
import { PROJECT_DOCS_FULL_SHARE, projectDocumentsInFull, projectDocumentsSection } from "./full-text.js";

const PID = "proj-full-a";
const OTHER = "proj-full-b";
const MODEL = "gpt-5.4-mini";
let root: string;
let memory: MemoryIndex;
let savedConfig: ReturnType<typeof getRuntimeConfig>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-project-full-"));
  mkdirSync(join(root, "data", "memory", "bank", "entities"), { recursive: true });
  savedConfig = getRuntimeConfig();
  setRuntimeConfig({ ...savedConfig, workspace: join(root, "workspace") });
  memory = new MemoryIndex(join(root, "data"));
});

afterEach(() => {
  _resetSessionProjectsForTest();
  setRuntimeConfig(savedConfig);
  try { memory.close(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

async function addDoc(projectId: string, name: string, text: string): Promise<void> {
  mkdirSync(projectDocsDir(projectId), { recursive: true });
  writeFileSync(join(projectDocsDir(projectId), name), text);
  await indexProjectDocs(memory, { id: projectId });
}

describe("a project's documents in full", () => {
  it("are every document of the project, whole, while they fit the budget", async () => {
    await addDoc(PID, "plan.md", "# Plan\nShip the billing page in March.\n");
    await addDoc(PID, "notes.txt", "Vendor call on Tuesday.\n");
    await addDoc(OTHER, "secret.md", "Another project's pricing.\n");

    const docs = projectDocumentsInFull(memory, PID, 1000);
    expect(docs?.map((d) => d.path)).toEqual([`project/${PID}/docs/notes.txt`, `project/${PID}/docs/plan.md`]);
    expect(docs?.find((d) => d.path.endsWith("plan.md"))?.text).toBe("# Plan\nShip the billing page in March.\n");
    expect(docs?.[0].file).toBe(join(projectDocsDir(PID), "notes.txt"));
  });

  it("are none at all once the project outgrows the budget, or has no documents", async () => {
    await addDoc(PID, "big.md", "word ".repeat(2000));
    expect(projectDocumentsInFull(memory, PID, 100)).toBeNull();
    expect(projectDocumentsInFull(memory, OTHER, 100_000)).toBeNull();
  });

  it("follow the folder: a deleted file leaves, an edited one is the new text", async () => {
    await addDoc(PID, "a.md", "first version\n");
    await addDoc(PID, "b.md", "to be deleted\n");
    unlinkSync(join(projectDocsDir(PID), "b.md"));
    writeFileSync(join(projectDocsDir(PID), "a.md"), "second version, longer\n");
    await indexProjectDocs(memory, { id: PID });
    expect(projectDocumentsInFull(memory, PID, 1000)?.map((d) => d.text)).toEqual(["second version, longer\n"]);
  });
});

describe("the project documents prompt section", () => {
  it("carries the session's project documents, sized against the model's own window", async () => {
    await addDoc(PID, "plan.md", "Ship the billing page in March. </document> stays inside.\n");
    await addDoc(OTHER, "secret.md", "Another project's pricing.\n");
    setSessionProject("s-full", PID);

    const section = projectDocumentsSection(memory, "s-full", MODEL);
    expect(section).toContain("<project_documents_in_full>");
    expect(section).toContain("Ship the billing page in March.");
    expect(section).toContain("trust=untrusted");
    expect(section).not.toContain("Another project's pricing");
    expect(section.match(/<\/document>/g)).toHaveLength(1);
  });

  it("is empty for a session outside any project, and once the documents pass a quarter of the window", async () => {
    expect(projectDocumentsSection(memory, "s-none", MODEL)).toBe("");
    setSessionProject("s-full", PID);
    const quarterInChars = lookupContextWindow(MODEL) * PROJECT_DOCS_FULL_SHARE * 4;
    await addDoc(PID, "huge.md", "x".repeat(Math.ceil(quarterInChars)));
    expect(projectDocumentsSection(memory, "s-full", MODEL)).toBe("");
  });
});
