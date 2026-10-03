import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../../logger.js";
import { pullMergedRecordFile, unionMergeBy } from "./merge-helpers.js";

const logger = createLogger("sync.pull-files.merged-json");

export async function pullAgentProjects(dataDir: string, syncDir: string): Promise<void> {
  // agent-projects.json: union-merge + project-tombstone filter.
  // Closes the 2026-05-22 case where a locally-created project was
  // wiped by pull from a stale sync-repo.
  const { projectTombstonePaths, listTombstonedProjectIds, applyProjectTombstones } = await import("../project-tombstones.js");
  const tombstoned = listTombstonedProjectIds(projectTombstonePaths(dataDir, syncDir));
  pullMergedRecordFile<{ id: string; updatedAt?: number }>({
    dataDir, syncDir, fileName: "agent-projects.json",
    filterTombstoned: (recs) => {
      const filtered = applyProjectTombstones(recs, tombstoned);
      const wiped = recs.length - filtered.length;
      if (wiped > 0) logger.info(`[sync] project tombstones filtered ${wiped} project(s)`);
      return filtered as typeof recs;
    },
  });
}

export function pullIssuesAndTemplates(dataDir: string, syncDir: string): void {
  // agent-issues.json + agent-templates.json: same record-array shape,
  // same union-merge fix. Issues created or templates edited on this
  // machine that haven't been pushed yet now survive a stale pull. No
  // tombstone store for these today; if individual issues/templates
  // need delete-propagation later, add a tombstone source like
  // project-tombstones.ts.
  pullMergedRecordFile<{ id: string; updatedAt?: number }>({
    dataDir, syncDir, fileName: "agent-issues.json",
  });
  pullMergedRecordFile<{ id: string; updatedAt?: number }>({
    dataDir, syncDir, fileName: "agent-templates.json",
  });
}

export function pullTasks(dataDir: string, syncDir: string): void {
  // tasks.json: array of {id, updated_at, ...}. Same merge semantic as
  // projects/issues/templates but with snake_case timestamp. Inlined
  // because the field name shift is too small to justify a separate
  // helper.
  const remotePath = join(syncDir, "tasks.json");
  const localPath = join(dataDir, "tasks.json");
  if (!existsSync(remotePath)) return;
  try {
    const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
    const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : [];
    if (Array.isArray(remote) && Array.isArray(local)) {
      const merged = unionMergeBy<{ id: string; updated_at?: number }>(
        local, remote,
        (x) => x.id,
        (l, r) => (Number(l.updated_at) || 0) > (Number(r.updated_at) || 0),
      );
      writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
    }
  } catch (e) {
    logger.warn(`[sync] tasks.json pull skipped: ${(e as Error).message}`);
  }
}

export function pullCalendar(dataDir: string, syncDir: string): void {
  // calendar.json: wrapped {events: [{id, ...}]}. No per-event
  // timestamp -- on collision, local wins (most-recently-edited on this
  // machine). Cross-machine convergence still happens because remote-
  // only events are added. Preserves any non-events top-level fields by
  // shallow-merging.
  const remotePath = join(syncDir, "calendar.json");
  const localPath = join(dataDir, "calendar.json");
  if (!existsSync(remotePath)) return;
  try {
    const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
    const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : { events: [] };
    const remoteEvents = Array.isArray(remote?.events) ? remote.events : [];
    const localEvents = Array.isArray(local?.events) ? local.events : [];
    const events = unionMergeBy<{ id: string }>(
      localEvents, remoteEvents,
      (x) => x.id,
      () => true,
    );
    const merged = { ...remote, ...local, events };
    writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
  } catch (e) {
    logger.warn(`[sync] calendar.json pull skipped: ${(e as Error).message}`);
  }
}

export function pullCustomMissions(dataDir: string, syncDir: string): void {
  // custom-missions.json: array of {name, ...}. Name-keyed, no timestamp.
  // On collision, local wins (a mission edited on this machine wins over
  // a stale remote copy with the same name).
  const remotePath = join(syncDir, "custom-missions.json");
  const localPath = join(dataDir, "custom-missions.json");
  if (!existsSync(remotePath)) return;
  try {
    const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
    const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : [];
    if (Array.isArray(remote) && Array.isArray(local)) {
      const merged = unionMergeBy<{ name: string }>(
        local, remote,
        (x) => x.name,
        () => true,
      );
      writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
    }
  } catch (e) {
    logger.warn(`[sync] custom-missions.json pull skipped: ${(e as Error).message}`);
  }
}
