/**
 * Start a chat from another: the one way a linked chat is created and run.
 * The user's tap on a session_start card (routes/sessions-start.ts) and a
 * session_start the user asked for in words (tools/session-start-tool.ts)
 * both come here.
 *
 * The new chat works where the starting one does (a code session's folder, a
 * chat's bound app folder), unless it is started in a new project folder:
 * then it is a Code-mode chat on `workspace/apps/<name>`, which the app serves,
 * so the project opens on the phone too. Its first turn runs on its own
 * (session/linked-chat.ts) and the starting chat hears when it is done. Open
 * tabs are told the chat list changed, so it shows at once.
 *
 * A tool has no ServerContext, so the server registers a starter bound to its
 * own at boot (server/lifecycle.ts), as it registers the chat handler.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { workspacePath } from "../config.js";
import type { ServerContext } from "../server-context.js";
import { codeFolderProject } from "../agent-store/code-folder-project.js";
import { runLinkedChat } from "./linked-chat.js";
import { sessionModeOf } from "./mode.js";
import { createLogger } from "../logger.js";

const logger = createLogger("session.start-linked-chat");

export interface LinkedChatRequest {
  /** The chat it is started from. */
  originId: string;
  title: string;
  /** The new chat's first message. */
  brief: string;
  /** A project folder name: the chat runs in Code mode on `workspace/apps/<folder>`, created if missing. */
  folder?: string;
}

export interface StartedChat {
  sessionId: string;
  title: string;
  /** The project folder the chat works in, when it was started in one. */
  folder?: string;
}

export class StartChatError extends Error {}

const FOLDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** `workspace/apps/<name>`, created if missing. Refuses a name that is not one plain folder name. */
export function projectFolder(name: string): string {
  if (!FOLDER_NAME.test(name) || name.includes("..")) {
    throw new StartChatError(`"${name}" is not a project folder name: letters, digits, dot, dash or underscore, no slashes.`);
  }
  const folder = workspacePath("apps", name);
  if (existsSync(folder) && !statSync(folder).isDirectory()) throw new StartChatError(`${folder} exists and is not a folder.`);
  mkdirSync(folder, { recursive: true });
  return folder;
}

export async function startLinkedChat(ctx: ServerContext, req: LinkedChatRequest): Promise<StartedChat> {
  const origin = ctx.sessionStore.load(req.originId);
  if (!origin) throw new StartChatError("The chat that started this is gone.");
  const folder = req.folder ? projectFolder(req.folder) : undefined;
  const project = folder ? await codeFolderProject(folder, ctx.projectStore) : undefined;
  const code = folder !== undefined || sessionModeOf(origin) === "code";
  const now = Date.now();
  const sessionId = `task-${randomBytes(8).toString("hex")}`;
  await ctx.saveSession({
    id: sessionId, title: req.title, messages: [], createdAt: now, updatedAt: now,
    startedFrom: req.originId,
    ...(code ? { mode: "code" as const } : {}),
    // A new project folder is the chat's own; otherwise it works where the
    // starting chat does: a code session's project (its folder), a chat's bound app folder.
    ...(project ? { projectId: project.id } : origin.projectId ? { projectId: origin.projectId } : {}),
    ...(!project && origin.folder ? { folder: origin.folder } : {}),
  });
  ctx.broadcastAll({ type: "chat_list_changed", at: now });
  void runLinkedChat(ctx, {
    originId: req.originId, originTitle: origin.title, sessionId, title: req.title, brief: req.brief,
    mode: code ? "code" : sessionModeOf(origin),
  }).catch((e) => logger.warn(`[start-linked-chat] ${sessionId}: ${(e as Error).message}`));
  return { sessionId, title: req.title, ...(folder ? { folder } : {}) };
}

export type LinkedChatStarter = (req: LinkedChatRequest) => Promise<StartedChat>;

let starter: LinkedChatStarter | null = null;
/** The server binds the starter to its ServerContext at boot. */
export function setLinkedChatStarter(s: LinkedChatStarter | null): void { starter = s; }
export function getLinkedChatStarter(): LinkedChatStarter | null { return starter; }
