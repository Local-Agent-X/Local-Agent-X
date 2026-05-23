import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { PROVIDER_IDS, type ProviderId as CanonicalProviderId } from "../../providers/provider-ids.js";
import { PROVIDERS } from "../../providers/registry.js";
import type { AgentModelPin } from "../../agents/types.js";

export const handleRosterRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Patch a roster entry — reportsTo / heartbeatSchedule live per project
  // post-L3, so the old PUT /api/agents/templates/:id can't carry these.
  if (method === "PATCH" && url.pathname.match(/^\/api\/projects\/[^/]+\/rosters\/[^/]+$/)) {
    const parts = url.pathname.split("/");
    const projectId = parts[3];
    const agentId = parts[5];
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }

    // Model field — {provider, model}, or null to clear the per-project
    // override (template default takes over again). Validated against the
    // canonical provider+model registry; bad pairs reject 400 so the UI
    // doesn't silently persist garbage.
    let modelField: AgentModelPin | null | undefined = undefined;
    if (body.model === null) {
      modelField = null;
    } else if (body.model && typeof body.model === "object") {
      const m = body.model as { provider?: unknown; model?: unknown };
      const provider = typeof m.provider === "string" ? m.provider : "";
      const modelName = typeof m.model === "string" ? m.model : "";
      if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
        json(400, { error: `Unknown provider "${provider}" — must be one of: ${PROVIDER_IDS.join(", ")}` });
        return true;
      }
      const reg = PROVIDERS[provider as CanonicalProviderId];
      if (reg.models.length > 0 && !reg.models.includes(modelName)) {
        json(400, { error: `Model "${modelName}" is not in the ${provider} registry. Known: ${reg.models.join(", ")}` });
        return true;
      }
      modelField = { provider: provider as CanonicalProviderId, model: modelName };
    }

    const { ProjectRosterStore } = await import("../../project-rosters.js");
    const updated = ProjectRosterStore.getInstance().patch(projectId, agentId, {
      reportsTo: body.reportsTo as string | undefined,
      heartbeatSchedule: body.heartbeatSchedule as string | undefined,
      heartbeatEnabled: body.heartbeatEnabled as boolean | undefined,
      model: modelField,
    });
    if (!updated) { json(404, { error: "Roster entry not found" }); return true; }
    json(200, updated); return true;
  }

  return false;
};
