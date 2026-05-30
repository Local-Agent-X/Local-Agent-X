import type { RouteHandler } from "../server-context.js";
import { jsonResponse, readBody } from "../server-utils.js";
import type { FactKind } from "../memory/index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("routes.memory");

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

  if (method === "GET" && url.pathname === "/api/memory/atlas") {
    const raw = parseInt(url.searchParams.get("limit") || "40000", 10);
    const limit = Math.min(40000, Math.max(1, Number.isFinite(raw) ? raw : 40000));
    const recs = ctx.memoryIndex.atlasRecords(limit);
    const layout = await ctx.memoryIndex.atlasLayout();
    if (!layout) {
      // No layout yet (e.g. no embeddings) — return flat records; the brain
      // falls back to scatter positioning.
      json(200, { total: recs.total, clusters: [], items: recs.items });
      return true;
    }
    const byId = new Map(recs.items.map((it) => [it.id, it]));
    const items = [];
    for (let i = 0; i < layout.ids.length; i++) {
      const it = byId.get(layout.ids[i]);
      if (!it) continue;
      items.push({
        ...it,
        x: layout.xyz[i * 3],
        y: layout.xyz[i * 3 + 1],
        z: layout.xyz[i * 3 + 2],
        cluster: layout.cluster[i],
      });
    }
    json(200, { total: recs.total, clusters: layout.clusters, items });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/memory/chunk") {
    const id = parseInt(url.searchParams.get("id") || "", 10);
    if (!Number.isFinite(id)) { json(400, { error: "id parameter required" }); return true; }
    const chunk = ctx.memoryIndex.atlasChunk(id);
    if (!chunk) { json(404, { error: "not found" }); return true; }
    json(200, chunk);
    return true;
  }

  // [chat-diag] frontend → server log sink. Browser console.logs don't
  // persist to disk and asking non-technical users to open DevTools is a
  // non-starter. Frontend diag breadcrumbs POST here and the message is
  // routed through console.log so it lands in ~/.lax/logs/server.log
  // (via the global console override in src/index.ts). Remove after the
  // fresh-install chat bug is rooted out. Path is namespaced under
  // /api/diag so future temporary instrumentation can colocate.
  if (method === "POST" && url.pathname === "/api/diag/log") {
    try {
      const body = JSON.parse(await readBody(req)) as { tag?: string; message?: string };
      const tag = typeof body.tag === "string" ? body.tag : "diag";
      const message = typeof body.message === "string" ? body.message : "";
      console.log(`[${tag}] frontend ${message}`);
      json(200, { ok: true });
    } catch { json(400, { error: "Invalid body" }); }
    return true;
  }

  // Re-run the embedding-provider init. Idempotent — call after the Ollama
  // model lands post-boot (fresh install race: server boots before Ollama
  // pull finishes, so the cached provider is degraded). Returns the new
  // provider name + model + whether it's still degraded so the caller can
  // surface a clean "Memory engine: connected" status.
  if (method === "POST" && url.pathname === "/api/memory/reinit") {
    try {
      const { initOrRefreshEmbeddingProvider } = await import("../server/bootstrap-services.js");
      const result = await initOrRefreshEmbeddingProvider({
        config: ctx.config,
        dataDir: ctx.dataDir,
        secretsStore: ctx.secretsStore,
        memoryIndex: ctx.memoryIndex,
      });
      json(200, { ok: true, ...result });
    } catch (e) {
      json(500, { error: "Embedding re-init failed: " + (e as Error).message });
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/memory/health") {
    try {
      const { MemoryOrchestrator } = await import("../orchestrator/orchestrator.js");
      json(200, MemoryOrchestrator.getInstance().getSystemHealth());
    } catch (e) {
      json(500, { error: "Memory health check failed: " + (e as Error).message });
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/memory/background") {
    try {
      const { MemoryOrchestrator } = await import("../orchestrator/orchestrator.js");
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

  // Ingest uploaded conversation files
  if (method === "POST" && url.pathname === "/api/memory/ingest") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) { json(400, { error: "Multipart form data required" }); return true; }
    try {
      const { mkdirSync, writeFileSync, unlinkSync } = await import("fs");
      const { join } = await import("path");
      const { tmpdir } = await import("os");
      // Read multipart body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/)?.[2];
      if (!boundary) { json(400, { error: "No boundary in content-type" }); return true; }
      // Parse multipart to extract files
      const tmpDir = join(tmpdir(), "lax-ingest-" + Date.now());
      mkdirSync(tmpDir, { recursive: true });
      const files: string[] = [];
      const parts = body.toString("binary").split("--" + boundary).filter(p => p.includes("filename="));
      for (const part of parts) {
        const nameMatch = part.match(/filename="([^"]+)"/);
        if (!nameMatch) continue;
        const filename = nameMatch[1].replace(/[^a-zA-Z0-9._-]/g, "_");
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0) continue;
        const fileContent = part.slice(headerEnd + 4).replace(/\r\n$/, "").replace(/--\r\n$/, "").replace(/--$/, "");
        const filePath = join(tmpDir, filename);
        writeFileSync(filePath, fileContent, "binary");
        files.push(filePath);
      }
      if (files.length === 0) { json(400, { error: "No files found in upload" }); return true; }
      // Run ingest
      const { ingestConversations } = await import("../conversation/ingest.js");
      const result = await ingestConversations(ctx.memoryIndex, tmpDir);
      // Clean up temp files
      for (const f of files) try { unlinkSync(f); } catch {}
      try { const { rmSync } = await import("fs"); rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      json(200, result);
    } catch (e) {
      json(500, { error: "Ingest failed: " + (e as Error).message });
    }
    return true;
  }

  // Debug: test indexChunks directly
  if (method === "POST" && url.pathname === "/api/memory/test-index") {
    try {
      const { chunkConversationPairs } = await import("../memory/chunking.js");
      const testMessages = [
        { role: "user" as const, content: "This is a test message for debugging indexChunks" },
        { role: "assistant" as const, content: "I received your test message. This confirms the ingest pipeline works." },
      ];
      const chunks = chunkConversationPairs(testMessages, "import/test/debug-" + Date.now(), "import", { source_type: "import", session_id: "test-debug" });
      logger.info(`[test-index] Created ${chunks.length} chunks, calling indexChunks...`);
      await ctx.memoryIndex.indexChunks(chunks, "import/test/debug-" + Date.now(), "import");
      logger.info(`[test-index] indexChunks returned`);
      // Verify
      const stats = ctx.memoryIndex.getStats();
      json(200, { ok: true, chunksCreated: chunks.length, totalChunks: stats.totalChunks });
    } catch (e) {
      json(500, { error: (e as Error).message, stack: (e as Error).stack?.slice(0, 500) });
    }
    return true;
  }

  // Ingest from a local directory path
  if (method === "POST" && url.pathname === "/api/memory/ingest-path") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON body" }); return true; }
    const path = body.path as string;
    if (!path) { json(400, { error: "path required" }); return true; }
    try {
      const { ingestConversations } = await import("../conversation/ingest.js");
      const result = await ingestConversations(ctx.memoryIndex, path);
      json(200, result);
    } catch (e) {
      json(500, { error: "Ingest failed: " + (e as Error).message });
    }
    return true;
  }

  return false;
};
