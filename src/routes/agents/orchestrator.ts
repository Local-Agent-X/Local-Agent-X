/**
 * The orchestrator role of a project, for the strip in a chat's window
 * (ADR 0007 §7, agency/orchestrator-role.ts).
 *
 *   POST /api/work-claims/orchestrator  {sessionId, action, routing?}
 *     "take"    — this chat becomes its project's orchestrator (replacing any
 *                 other); `routing` is the user's model preferences, in words
 *     "release" — it gives the role up
 *
 * `orchestratorView` is what GET /api/work-claims?session= adds for the chat:
 * whether it holds the role, who does when it is another chat, and the model
 * preferences on record.
 */
import type { RouteHandler, ServerContext } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { orchestratorOf, releaseOrchestratorRole, repoKeyOfFolder, takeOrchestratorRole, ROUTING_MAX } from "../../agency/orchestrator-role.js";
import { ownCopyOf } from "../../agency/chat-own-copy.js";
import { liveHolders } from "../../agency/work-claims.js";
import { sessionProjectFolder } from "../../session/project-folder.js";
import { isPinnableSessionId } from "../../session/model-pin.js";

export interface OrchestratorView {
  /** False when the chat's project is not a git repo: there is no role to hold. */
  available: boolean;
  mine: boolean;
  /** The chat that holds the role, when it is not this one. */
  heldBy: string | null;
  routing: string;
}

function repoKeyOfSession(ctx: Pick<ServerContext, "sessionStore">, sessionId: string): string | null {
  const copy = ownCopyOf(sessionId);
  if (copy) return repoKeyOfFolder(copy.repoRoot);
  const session = ctx.sessionStore.load(sessionId);
  const folder = session ? sessionProjectFolder({ id: session.id, mode: session.mode, projectId: session.projectId, folder: session.folder }) : undefined;
  return folder ? repoKeyOfFolder(folder) : null;
}

export function orchestratorView(ctx: Pick<ServerContext, "sessionStore">, sessionId: string): OrchestratorView {
  const repoKey = repoKeyOfSession(ctx, sessionId);
  if (!repoKey) return { available: false, mine: false, heldBy: null, routing: "" };
  const role = orchestratorOf(repoKey);
  if (!role) return { available: true, mine: false, heldBy: null, routing: "" };
  if (role.sessionId === sessionId) return { available: true, mine: true, heldBy: null, routing: role.routing };
  const holder = liveHolders(repoKey).find((h) => h.sessionId === role.sessionId);
  const title = holder?.displayName ?? ctx.sessionStore.load(role.sessionId)?.title ?? "another chat";
  return { available: true, mine: false, heldBy: title, routing: "" };
}

export const handleOrchestratorRoutes: RouteHandler = async (method, url, req, res, ctx) => {
  if (method !== "POST" || url.pathname !== "/api/work-claims/orchestrator") return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const body = await safeParseBody(req);
  const sessionId = body?.sessionId;
  if (!body || !isPinnableSessionId(sessionId)) { json(400, { error: "sessionId required" }); return true; }
  const repoKey = repoKeyOfSession(ctx, sessionId);
  if (!repoKey) { json(409, { error: "This chat's project is not a git repository, so it has no orchestrator role." }); return true; }
  if (body.action === "take") {
    const routing = typeof body.routing === "string" ? body.routing : undefined;
    if (routing && routing.length > ROUTING_MAX) { json(400, { error: `Model preferences are limited to ${ROUTING_MAX} characters.` }); return true; }
    takeOrchestratorRole(sessionId, repoKey, routing);
  } else if (body.action === "release") {
    releaseOrchestratorRole(sessionId, repoKey);
  } else {
    json(400, { error: "action must be take or release" }); return true;
  }
  try {
    const { broadcastAll } = await import("../../chat-ws/index.js");
    broadcastAll({ type: "work_claims_changed" });
  } catch { /* no socket server in tests */ }
  json(200, { ok: true, ...orchestratorView(ctx, sessionId) });
  return true;
};
