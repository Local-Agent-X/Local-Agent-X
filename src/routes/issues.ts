// Issues REST surface for the Agents UI. Thin wrapper over IssueStore.
//
// The chat-side agent uses the issue_* tools (src/issue-tools.ts) — those
// stay the canonical, audited path. The UI needs the same data over HTTP;
// this router was missing, which is why every "view assigned tasks", "+
// Assign Task", and Issue tab interaction in public/js/agents.js failed
// with the swallowed "Failed to load" message.
//
//   GET    /api/issues?assignee=&status=&project=
//   GET    /api/issues/:id
//   POST   /api/issues
//   PUT    /api/issues/:id
//   POST   /api/issues/:id/comments
//   DELETE /api/issues/:id

import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";
import type { Issue, IssueStatus, IssuePriority } from "../agent-store/issue-store.js";

const VALID_STATUS: IssueStatus[] = ["open", "in-progress", "blocked", "done", "cancelled"];
const VALID_PRIORITY: IssuePriority[] = ["low", "medium", "high", "urgent"];

export const handleIssueRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/issues") {
    const assignee = url.searchParams.get("assignee") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const project = url.searchParams.get("project") || undefined;
    const opts: { assignee?: string; status?: IssueStatus; project?: string } = {};
    if (assignee) opts.assignee = assignee;
    if (status && VALID_STATUS.includes(status as IssueStatus)) opts.status = status as IssueStatus;
    if (project) opts.project = project;
    json(200, ctx.issueStore.list(opts));
    return true;
  }

  const idMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
  if (method === "GET" && idMatch) {
    const issue = ctx.issueStore.get(idMatch[1]);
    if (!issue) { json(404, { error: "Issue not found" }); return true; }
    json(200, issue);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/issues") {
    const body = await safeParseBody(req);
    if (!body || typeof body !== "object") { json(400, { error: "Invalid JSON" }); return true; }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) { json(400, { error: "title is required" }); return true; }
    const status = VALID_STATUS.includes(body.status as IssueStatus) ? body.status as IssueStatus : "open";
    const priority = VALID_PRIORITY.includes(body.priority as IssuePriority) ? body.priority as IssuePriority : "medium";
    const created = ctx.issueStore.create({
      title,
      description: typeof body.description === "string" ? body.description : "",
      assignee: typeof body.assignee === "string" ? body.assignee : "",
      status,
      priority,
      project: typeof body.project === "string" ? body.project : undefined,
      projectId: typeof body.projectId === "string" ? body.projectId : undefined,
      parentIssue: typeof body.parentIssue === "string" ? body.parentIssue : undefined,
      blockedBy: Array.isArray(body.blockedBy) ? (body.blockedBy as string[]) : undefined,
      createdBy: typeof body.createdBy === "string" ? body.createdBy : "user",
    });
    json(200, created);
    return true;
  }

  if (method === "PUT" && idMatch) {
    const body = await safeParseBody(req);
    if (!body || typeof body !== "object") { json(400, { error: "Invalid JSON" }); return true; }
    // Only let the UI patch a safe subset — title/description/assignee/status/
    // priority/project/projectId/blockedBy. Comments + locks go through their
    // own endpoints; createdBy/createdAt are immutable.
    const patch: Partial<Issue> = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.description === "string") patch.description = body.description;
    if (typeof body.assignee === "string") patch.assignee = body.assignee;
    if (typeof body.status === "string" && VALID_STATUS.includes(body.status as IssueStatus)) patch.status = body.status as IssueStatus;
    if (typeof body.priority === "string" && VALID_PRIORITY.includes(body.priority as IssuePriority)) patch.priority = body.priority as IssuePriority;
    if (typeof body.project === "string") patch.project = body.project;
    if (typeof body.projectId === "string") patch.projectId = body.projectId;
    if (Array.isArray(body.blockedBy)) patch.blockedBy = body.blockedBy as string[];
    const updated = ctx.issueStore.update(idMatch[1], patch);
    if (!updated) { json(404, { error: "Issue not found" }); return true; }
    json(200, updated);
    return true;
  }

  const commentsMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
  if (method === "POST" && commentsMatch) {
    const body = await safeParseBody(req);
    if (!body || typeof body !== "object") { json(400, { error: "Invalid JSON" }); return true; }
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) { json(400, { error: "content is required" }); return true; }
    const author = typeof body.author === "string" ? body.author : "user";
    const comment = ctx.issueStore.comment(commentsMatch[1], author, content);
    if (!comment) { json(404, { error: "Issue not found" }); return true; }
    json(200, comment);
    return true;
  }

  if (method === "DELETE" && idMatch) {
    const ok = ctx.issueStore.delete(idMatch[1]);
    if (!ok) { json(404, { error: "Issue not found" }); return true; }
    json(200, { ok: true });
    return true;
  }

  return false;
};
