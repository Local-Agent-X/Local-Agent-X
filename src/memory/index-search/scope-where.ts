import { PROFILE_SOURCES } from "../types.js";
import { projectDocPathPrefix } from "../project-docs/paths.js";

/**
 * The storage-layer scope gate both search channels put in their SQL, keyed
 * on chunks.source and chunks.path, never on metadata a model could author.
 * postProcess applies the same rules again to the merged results.
 *
 *  - `sessionFilter` undefined searches every session. Otherwise only profile
 *    sources and rows of that exact session are eligible; null matches no
 *    session.
 *  - A project document is eligible only in a search for its own project,
 *    whatever the session setting: one project's files never reach another
 *    project's chat, and a cross-session search does not widen that.
 *
 * `col` is the table alias prefix ("c." in the keyword join).
 */
export function scopeWhere(
  sessionFilter: string | null | undefined,
  projectId: string | undefined,
  col = "",
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let ownProject = "0";
  if (projectId) {
    const prefix = projectDocPathPrefix(projectId);
    ownProject = `(${col}source = 'project-doc' AND substr(${col}path, 1, ?) = ?)`;
    params.push(prefix.length, prefix);
  }
  let rest = `${col}source <> 'project-doc'`;
  if (sessionFilter !== undefined) {
    const profile = PROFILE_SOURCES.map((s) => `'${s}'`).join(", ");
    rest += ` AND (${col}source IN (${profile})${sessionFilter ? ` OR ${col}session_id = ?` : ""})`;
    if (sessionFilter) params.push(sessionFilter);
  }
  return { sql: `AND (${ownProject} OR (${rest}))`, params };
}
