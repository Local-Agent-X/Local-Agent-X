/**
 * The code-folder project for a folder: what a Code-mode session is filed under,
 * and where its folder comes from (session/project-folder.ts reads `workspace`).
 * Shared by the sidebar's add-folder (routes/agents/projects.ts), a chat
 * continuing in Code mode on the repo it worked in (routes/sessions-fork.ts),
 * and a chat started in a new project folder (session/start-linked-chat.ts).
 */
import { basename, dirname, resolve } from "node:path";
import type { Project, ProjectStore } from "./index.js";

/** Tell open tabs the project list changed (public/js/chat-ws-handler.js
 *  re-renders the sidebar). Best-effort: no socket layer in tests or scripts. */
export async function broadcastProjectsChanged(): Promise<void> {
  try {
    const { broadcastAll } = await import("../chat-ws/index.js");
    broadcastAll({ type: "projects_changed" });
  } catch { /* no WS context — the project itself was still saved */ }
}

/** The code-folder project for `folder` (a real directory): the one already on
 *  the sidebar, or a new one. A name another project holds gets the parent
 *  folder's name beside it, so two checkouts called `app` can both be added. */
export async function codeFolderProject(folder: string, store: ProjectStore): Promise<Project> {
  const same = (p: Project) => p.codeFolder && p.workspace && resolve(p.workspace).toLowerCase() === resolve(folder).toLowerCase();
  const existing = store.list().find(same);
  if (existing) return existing;
  const base = basename(folder) || folder;
  let name = base;
  if (store.findByName(name)) name = `${base} (${basename(dirname(folder)) || "folder"})`;
  for (let n = 2; store.findByName(name); n++) name = `${base} ${n}`;
  const project = store.create({ name, description: "", workspace: folder, codeFolder: true, agentIds: [] });
  await broadcastProjectsChanged();
  return project;
}
