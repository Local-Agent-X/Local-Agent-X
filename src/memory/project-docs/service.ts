// Keeps every chat project's documents indexed while the server runs: a pass
// per project shortly after start, a pass after anything in a project's
// folders changes, and a reconcile whenever the project list is written (a
// new project gets its folder and watcher, a deleted one's documents leave
// the index). Passes run one at a time so two never write the same paths.

import { watch, type FSWatcher } from "node:fs";
import type { MemoryIndex } from "../index-core.js";
import { EventBus } from "../../event-bus.js";
import { handleWatcherErrors } from "../../util/watcher-errors.js";
import { createLogger } from "../../logger.js";
import { agentMayRead, projectDocsFolders, type ProjectLike } from "./folders.js";
import { indexProjectDocs, indexedProjectIds, removeProjectDocs } from "./indexer.js";

const logger = createLogger("memory.project-docs");

/** Saving a file fires several events; one pass after they settle. */
const SETTLE_MS = 2000;
/** The first passes wait for the server to finish starting. */
const START_DELAY_MS = 5000;

export interface ProjectDocsIndex {
  /** Resolves when every queued pass has run (tests, shutdown). */
  idle(): Promise<void>;
  stop(): void;
}

export function startProjectDocsIndex(
  memory: MemoryIndex,
  listProjects: () => ProjectLike[],
  opts: { settleMs?: number; startDelayMs?: number } = {},
): ProjectDocsIndex {
  const settleMs = opts.settleMs ?? SETTLE_MS;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  const watchers = new Map<string, { key: string; handles: FSWatcher[] }>();
  const timers = new Map<string, NodeJS.Timeout>();

  const enqueue = (label: string, job: () => Promise<unknown>): void => {
    chain = chain.then(async () => { if (!stopped) await job(); })
      .catch((e) => logger.warn(`[project-docs] ${label} failed: ${(e as Error).message}`));
  };

  const live = (): ProjectLike[] => listProjects().filter((p) => !p.codeFolder);

  const schedule = (projectId: string, delay = settleMs): void => {
    clearTimeout(timers.get(projectId));
    const t = setTimeout(() => {
      timers.delete(projectId);
      const project = live().find((p) => p.id === projectId);
      if (project) enqueue(`pass ${projectId}`, () => indexProjectDocs(memory, project));
    }, delay);
    t.unref?.();
    timers.set(projectId, t);
  };

  const unwatch = (projectId: string): void => {
    for (const h of watchers.get(projectId)?.handles ?? []) h.close();
    watchers.delete(projectId);
  };

  const rewatch = (project: ProjectLike): void => {
    const dirs = projectDocsFolders(project).map((f) => f.dir).filter(agentMayRead);
    const key = dirs.join("\n");
    if (watchers.get(project.id)?.key === key) return;
    unwatch(project.id);
    const handles: FSWatcher[] = [];
    for (const dir of dirs) {
      try {
        handles.push(handleWatcherErrors(watch(dir, { recursive: true }, () => schedule(project.id)), "project-docs"));
      } catch (e) {
        logger.warn(`[project-docs] cannot watch ${dir}: ${(e as Error).message}`);
      }
    }
    watchers.set(project.id, { key, handles });
  };

  const reconcile = (delay = settleMs): void => {
    const projects = live();
    const ids = new Set(projects.map((p) => p.id));
    for (const project of projects) {
      rewatch(project);
      schedule(project.id, delay);
    }
    for (const id of [...watchers.keys()]) if (!ids.has(id)) unwatch(id);
    enqueue("removing deleted projects", async () => {
      for (const id of indexedProjectIds(memory)) if (!ids.has(id)) removeProjectDocs(memory, id);
    });
  };

  const onProjectsChanged = (): void => { if (!stopped) reconcile(); };
  EventBus.on("projects:changed", onProjectsChanged);
  reconcile(opts.startDelayMs ?? START_DELAY_MS);

  return {
    idle: async () => {
      while (timers.size) await new Promise((r) => setTimeout(r, Math.min(settleMs, 50)));
      await chain;
    },
    stop: () => {
      stopped = true;
      EventBus.off("projects:changed", onProjectsChanged);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const id of [...watchers.keys()]) unwatch(id);
    },
  };
}
