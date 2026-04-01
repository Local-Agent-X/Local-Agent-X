import type { RouteHandler } from "../server-context.js";
import { jsonResponse, readBody, safeParseBody } from "../server-utils.js";
import type { FactKind } from "../memory.js";

export const handleMemoryRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/memory/search") {
    const query = url.searchParams.get("q") || "";
    if (!query) { json(400, { error: "q parameter required" }); return true; }
    json(200, await ctx.memoryIndex.search(query));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/memory/stats") {
    json(200, ctx.memoryIndex.getStats());
    return true;
  }

  if (method === "GET" && url.pathname === "/api/memory/health") {
    try {
      const { MemoryOrchestrator } = await import("../memory-orchestrator.js");
      json(200, MemoryOrchestrator.getInstance().getSystemHealth());
    } catch (e) {
      json(500, { error: "Memory health check failed: " + (e as Error).message });
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/memory/background") {
    try {
      const { MemoryOrchestrator } = await import("../memory-orchestrator.js");
      json(200, MemoryOrchestrator.getInstance().runBackground(ctx.memoryIndex));
    } catch (e) {
      json(500, { error: "Memory background run failed: " + (e as Error).message });
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/memory/recall") {
    const entity = url.searchParams.get("entity") || undefined;
    const kind = url.searchParams.get("kind") as FactKind | undefined;
    const since = url.searchParams.get("since");

    let facts;
    if (entity) {
      facts = ctx.memoryIndex.recallByEntity(entity);
    } else if (kind) {
      facts = ctx.memoryIndex.recallByKind(kind);
    } else if (since) {
      facts = ctx.memoryIndex.recallByTime(new Date(since));
    } else {
      json(400, { error: "Provide entity, kind, or since parameter" }); return true;
    }
    json(200, facts);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/memory/reflect") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON body" }); return true; }
    const sinceDays = (body.since_days as number) || 7;
    json(200, await ctx.memoryIndex.reflect(sinceDays));
    return true;
  }

  return false;
};
