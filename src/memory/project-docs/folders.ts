// Which folders hold a project's documents, and whether the agent may read
// them. Every chat project has its own documents folder inside the agent's
// workspace (made for it, the target of the sidebar's "Add files"); a folder
// the user set on the project is searched too. A code folder is a repository
// the agent works in with its own search tools, so it has no documents index.

import { mkdirSync } from "node:fs";
import { workspacePath, workspaceRoot } from "../../config.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { evaluateFileAccess, loadFileAccessMode } from "../../security/layer/index.js";
import { isProjectId } from "./paths.js";

export interface ProjectLike {
  id: string;
  workspace?: string;
  codeFolder?: boolean;
}

/** The label a folder's documents carry in their virtual path, so a file of
 *  the same name in both folders stays two documents. */
export type FolderLabel = "docs" | "linked";

export interface DocsFolder {
  label: FolderLabel;
  dir: string;
}

/** `<workspace>/projects/<id>`: keyed by id so a rename never strands it. */
export function projectDocsDir(projectId: string): string {
  return workspacePath("projects", projectId);
}

/** The folders to index for `project`, its own folder created on the way. */
export function projectDocsFolders(project: ProjectLike): DocsFolder[] {
  if (project.codeFolder || !isProjectId(project.id)) return [];
  const own = projectDocsDir(project.id);
  mkdirSync(own, { recursive: true });
  const folders: DocsFolder[] = [{ label: "docs", dir: own }];
  const linked = project.workspace?.trim() ? resolveAgentPath(project.workspace.trim()) : null;
  if (linked && linked.toLowerCase() !== own.toLowerCase()) folders.push({ label: "linked", dir: linked });
  return folders;
}

/** The same read decision the agent's file tools get over this folder: a
 *  folder the agent may not open is never surfaced through search either. */
export function agentMayRead(dir: string): boolean {
  return evaluateFileAccess(workspaceRoot(), loadFileAccessMode(), () => false, "read", dir).allowed;
}
