// While the server runs, a project's documents follow its folder and the
// project list: a saved file is indexed, a new project is picked up when the
// project list is written, and a deleted project's documents leave the index.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../index.js";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import { EventBus } from "../../event-bus.js";
import { startProjectDocsIndex, type ProjectDocsIndex } from "./service.js";
import { projectDocsDir } from "./folders.js";
import { indexedProjectIds } from "./indexer.js";
import type { ProjectLike } from "./folders.js";

let root: string;
let memory: MemoryIndex;
let service: ProjectDocsIndex;
let projects: ProjectLike[];
let savedConfig: ReturnType<typeof getRuntimeConfig>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-project-docs-svc-"));
  mkdirSync(join(root, "data", "memory", "bank", "entities"), { recursive: true });
  savedConfig = getRuntimeConfig();
  setRuntimeConfig({ ...savedConfig, workspace: join(root, "workspace") });
  memory = new MemoryIndex(join(root, "data"));
  projects = [{ id: "proj-svc-a" }];
  service = startProjectDocsIndex(memory, () => projects, { settleMs: 50, startDelayMs: 10 });
});

afterEach(() => {
  service.stop();
  setRuntimeConfig(savedConfig);
  try { memory.close(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

const found = async (q: string, projectId: string) =>
  (await memory.search(q, { projectId, minScore: 0.01 })).filter((h) => h.source === "project-doc").map((h) => h.path);

describe("the project documents index while the server runs", () => {
  it("indexes a file saved into a project's folder", async () => {
    await service.idle();
    writeFileSync(join(projectDocsDir("proj-svc-a"), "roadmap.md"), "The roadmap moves billing to Q3.\n");
    await vi.waitFor(async () => {
      await service.idle();
      expect(await found("roadmap billing Q3", "proj-svc-a")).toEqual(["project/proj-svc-a/docs/roadmap.md"]);
    }, { timeout: 5000, interval: 100 });
  });

  it("picks up a new project and forgets a deleted one when the project list is written", async () => {
    await service.idle();
    projects = [...projects, { id: "proj-svc-b" }];
    void EventBus.emit("projects:changed", {});
    await service.idle();
    writeFileSync(join(projectDocsDir("proj-svc-b"), "menu.md"), "The winter menu adds a lentil soup.\n");
    await vi.waitFor(async () => {
      await service.idle();
      expect(await found("winter menu lentil soup", "proj-svc-b")).toHaveLength(1);
    }, { timeout: 5000, interval: 100 });

    projects = projects.filter((p) => p.id !== "proj-svc-b");
    void EventBus.emit("projects:changed", {});
    await service.idle();
    expect(indexedProjectIds(memory)).not.toContain("proj-svc-b");
  });

  it("waits quietly for a linked folder that does not exist yet, and indexes it once it does", async () => {
    const warn = vi.spyOn(console, "error");
    const linked = join(root, "workspace", "apps", "not-built-yet");
    projects = [{ id: "proj-svc-c", workspace: linked }];
    void EventBus.emit("projects:changed", {});
    await service.idle();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("cannot watch");

    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, "spec.md"), "The truck tracker shows each stop on a map.\n");
    void EventBus.emit("projects:changed", {});
    await vi.waitFor(async () => {
      await service.idle();
      expect(await found("truck tracker stop map", "proj-svc-c")).toEqual(["project/proj-svc-c/linked/spec.md"]);
    }, { timeout: 5000, interval: 100 });
    warn.mockRestore();
  });
});
