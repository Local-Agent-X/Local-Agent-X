import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";

export const handleProtocolRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── Protocols (reusable workflows: typed packs + bundled SKILL.md + user) ──
  // List endpoint — abbreviated payload for the sidebar (no body, capped triggers).
  if (method === "GET" && url.pathname === "/api/protocols") {
    try {
      const { getAllProtocols } = await import("../../protocols/index.js");
      const catFallback: Record<string, string> = {
        instagram: "Social Media", twitter: "Social Media", facebook: "Social Media", tiktok: "Social Media",
        git: "Developer", deploy: "Developer", test: "Developer", pr: "Developer",
        research: "Research", summarize: "Research",
        email: "Communication", slack: "Communication", discord: "Communication", whatsapp: "Communication",
        smart: "Smart Home", light: "Smart Home",
      };
      function deriveCategory(p: { name: string; category?: string }): string {
        if (p.category) return p.category;
        const n = p.name.toLowerCase();
        for (const [key, cat] of Object.entries(catFallback)) { if (n.includes(key)) return cat; }
        return "General";
      }
      const protocols = getAllProtocols().map((m) => ({
        name: m.name,
        description: m.description,
        triggers: (m.triggers || []).slice(0, 3),
        steps: m.steps?.length ?? 0,
        category: deriveCategory(m),
        tags: m.tags || [],
        source: m.source || { type: "builtin" as const },
        // body deliberately omitted — list payload stays small; UI fetches /:name for full record.
      }));
      json(200, { protocols });
    } catch { json(200, { protocols: [] }); }
    return true;
  }
  // Detail endpoint — full record including body, steps, rules, allowedTools.
  if (method === "GET" && url.pathname.match(/^\/api\/protocols\/[^/]+$/)) {
    const name = decodeURIComponent(url.pathname.split("/").pop()!);
    try {
      const { getAllProtocols } = await import("../../protocols/index.js");
      const protocol = getAllProtocols().find((p) => p.name === name);
      if (!protocol) { json(404, { error: "Protocol not found" }); return true; }
      json(200, { protocol });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  // Create — user-custom protocol. Body: { name, description, body?, triggers?, category?, tags?, steps?, rules? }
  if (method === "POST" && url.pathname === "/api/protocols") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const { createProtocol } = await import("../../protocols/builder.js");
      const name = String((body as { name?: string }).name || "").trim();
      if (!name) { json(400, { error: "name is required" }); return true; }
      const p = body as Record<string, unknown>;
      const created = createProtocol({
        name,
        description: String(p.description || ""),
        triggers: Array.isArray(p.triggers) ? (p.triggers as string[]) : [name],
        steps: Array.isArray(p.steps) ? (p.steps as []) : [],
        rules: Array.isArray(p.rules) ? (p.rules as string[]) : [],
        learnablePreferences: Array.isArray(p.learnablePreferences) ? (p.learnablePreferences as string[]) : [],
        body: typeof p.body === "string" ? (p.body as string) : undefined,
        category: typeof p.category === "string" ? (p.category as string) : undefined,
        tags: Array.isArray(p.tags) ? (p.tags as string[]) : undefined,
        source: { type: "custom" },
      });
      json(200, { ok: true, protocol: created });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  // Edit — user/imported only. Built-in typed packs are read-only; UI must fork first.
  if (method === "PATCH" && url.pathname.match(/^\/api\/protocols\/[^/]+$/)) {
    const name = decodeURIComponent(url.pathname.split("/").pop()!);
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const { getAllProtocols } = await import("../../protocols/index.js");
      const existing = getAllProtocols().find((p) => p.name === name);
      if (!existing) { json(404, { error: "Protocol not found" }); return true; }
      const stype = existing.source?.type ?? "builtin";
      if (stype === "builtin" || stype === "bundled") {
        json(403, { error: "built-in/bundled protocols are read-only — fork to a user copy first" });
        return true;
      }
      const { editProtocol, createProtocol, loadCustomProtocols } = await import("../../protocols/builder.js");
      const updates = body as Partial<{ description: string; body: string; triggers: string[]; category: string; tags: string[]; steps: []; rules: string[] }>;
      // Imported (SKILL.md) entries don't live in custom-protocols.json yet —
      // first edit promotes them to a custom override. The original SKILL.md
      // file stays on disk so re-import of the upstream is still possible.
      const inCustom = loadCustomProtocols().some((p) => p.name === name);
      if (!inCustom && stype === "imported") {
        const promoted = createProtocol({ ...existing, ...updates, name, source: { type: "custom", attribution: `edited from imported ${name}` } });
        json(200, { ok: true, protocol: promoted });
        return true;
      }
      const updated = editProtocol(name, updates);
      json(200, { ok: true, protocol: updated });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  // Fork — copies a built-in/bundled protocol to user-custom under same or new name.
  if (method === "POST" && url.pathname.match(/^\/api\/protocols\/[^/]+\/fork$/)) {
    const sourceName = decodeURIComponent(url.pathname.split("/")[3]);
    try {
      const body = (await safeParseBody(req)) as { newName?: string } | null;
      const { getAllProtocols } = await import("../../protocols/index.js");
      const original = getAllProtocols().find((p) => p.name === sourceName);
      if (!original) { json(404, { error: "Source protocol not found" }); return true; }
      const { createProtocol } = await import("../../protocols/builder.js");
      const newName = (body?.newName?.trim()) || `${sourceName}_mine`;
      const forked = createProtocol({
        ...original,
        name: newName,
        source: { type: "custom", repo: original.source?.repo, attribution: `forked from ${sourceName}` },
      });
      json(200, { ok: true, protocol: forked });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  // Delete — user/imported only.
  if (method === "DELETE" && url.pathname.match(/^\/api\/protocols\/[^/]+$/)) {
    const name = decodeURIComponent(url.pathname.split("/").pop()!);
    try {
      const { getAllProtocols } = await import("../../protocols/index.js");
      const existing = getAllProtocols().find((p) => p.name === name);
      if (!existing) { json(404, { error: "Protocol not found" }); return true; }
      const stype = existing.source?.type ?? "builtin";
      if (stype === "builtin" || stype === "bundled") {
        json(403, { error: "built-in/bundled protocols cannot be deleted — they're vendored. Override locally instead." });
        return true;
      }
      // Mirror the protocol_delete tool semantics: ?permanent=true hard-deletes,
      // default soft-archives (recoverable via POST /api/protocols/:name/unarchive
      // or the protocol_unarchive tool).
      const permanent = url.searchParams.get("permanent") === "true";
      if (permanent) {
        const { deleteProtocol } = await import("../../protocols/builder.js");
        const ok = deleteProtocol(name);
        json(200, { ok, mode: "permanent" });
      } else {
        const { archiveProtocol } = await import("../../protocols/archive.js");
        const reason = url.searchParams.get("reason") || undefined;
        const rec = archiveProtocol(name, reason);
        json(200, { ok: rec !== null, mode: "archived" });
      }
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
