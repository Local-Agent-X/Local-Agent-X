// A project's documents sit in the memory index under a virtual path that
// names their project, so a search is scoped to one project by path prefix
// (index-search/scope-where.ts) and nothing else in the index can collide
// with them.

/** Real ids are `proj-<base36>-<hex>`. Anything outside this alphabet could
 *  climb out of a folder or widen a path prefix. */
export function isProjectId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/** Every project document's virtual path starts with this. */
export const PROJECT_DOC_PATH_ROOT = "project/";

/** The trailing slash keeps `proj-a` from matching `proj-ab`'s documents. */
export function projectDocPathPrefix(projectId: string): string {
  return `${PROJECT_DOC_PATH_ROOT}${projectId}/`;
}

/** The index path of a document at `relPath` inside its project's folder. */
export function projectDocPath(projectId: string, relPath: string): string {
  return projectDocPathPrefix(projectId) + relPath.split(/[\\/]+/).filter(Boolean).join("/");
}
