import type { RouteHandler } from "../../server-context.js";
import type { Protocol, ProtocolStep } from "../../protocols/types.js";
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
  // Archived list — the read half of the recoverable delete. MUST stay above the
  // /:name detail route below, whose regex would otherwise swallow this path;
  // "archived" is therefore a reserved protocol name at the HTTP layer.
  if (method === "GET" && url.pathname === "/api/protocols/archived") {
    try {
      const { loadArchived } = await import("../../protocols/archive.js");
      const archived = loadArchived().map((r) => ({
        name: r.protocol.name,
        description: r.protocol.description,
        triggers: (r.protocol.triggers || []).slice(0, 3),
        steps: r.protocol.steps?.length ?? 0,
        category: r.protocol.category,
        tags: r.protocol.tags || [],
        // Archive only ever holds custom-tier records (archiveProtocol reads
        // custom.json), so the fallback matches what the loader would stamp.
        source: r.protocol.source || { type: "custom" as const },
        archivedTs: r.archivedTs,
        reason: r.reason,
      }));
      json(200, { archived });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
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
        // This route IS the user's authoring path (the Protocols tab posts
        // here), so stamp user provenance. Deliberately not settable from the
        // body: an HTTP caller must not be able to forge agent authorship.
        source: { type: "custom", authoredBy: "user", authoredAt: Date.now() },
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
      // Whitelist at RUNTIME, not just in the type. `body as Partial<...>` is a
      // cast that filters nothing, and both branches below shallow-merge whatever
      // they're handed — so an unfiltered body could rewrite `source` and forge
      // agent authorship over HTTP. Authorship is set by create/fork only.
      // NOTE: this also stops PATCH renaming a record — `editProtocol` honours
      // `updates.name` (builder.ts: `name: updates.name ?? existing.name`), and a
      // rename would strand usage rows, the dedup embedding and the archive, all
      // of which key on name. The UI is unaffected only because `#edit-name` is
      // disabled while editing, so protocolSave always resends the current name.
      // Re-enabling that input means building a real rename path, not widening
      // this list.
      const raw = body as Record<string, unknown>;
      const updates: Partial<Protocol> = {};
      if (typeof raw.description === "string") updates.description = raw.description;
      if (typeof raw.body === "string") updates.body = raw.body;
      if (Array.isArray(raw.triggers)) updates.triggers = raw.triggers as string[];
      if (typeof raw.category === "string") updates.category = raw.category;
      if (Array.isArray(raw.tags)) updates.tags = raw.tags as string[];
      if (Array.isArray(raw.steps)) updates.steps = raw.steps as ProtocolStep[];
      if (Array.isArray(raw.rules)) updates.rules = raw.rules as string[];
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
      // A fork is a NEW user-authored copy: rebuild `source` rather than spread
      // the original's. Upstream identity (repo/commit/license) is carried for
      // attribution; `sourcePath` is dropped on purpose — the fork lives in
      // custom.json, not behind the original SKILL.md file. Authorship is
      // stamped "user" explicitly so forking an agent-authored protocol yields
      // an honest record instead of inheriting "agent" or going unlabelled.
      // `pinned` is NOT inherited: pinning is a decision about one protocol's
      // exemption from auto-archive, not a property of its content.
      const forked = createProtocol({
        ...original,
        name: newName,
        pinned: undefined,
        source: {
          type: "custom",
          repo: original.source?.repo,
          commit: original.source?.commit,
          license: original.source?.license,
          attribution: `forked from ${sourceName}`,
          authoredBy: "user",
          authoredAt: Date.now(),
        },
      });
      json(200, { ok: true, protocol: forked });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  // Unarchive — the undo half of the default (soft) delete. Without this the
  // archive is only reachable from agent tools, so the user's undo doesn't
  // exist in the UI.
  if (method === "POST" && url.pathname.match(/^\/api\/protocols\/[^/]+\/unarchive$/)) {
    const name = decodeURIComponent(url.pathname.split("/")[3]);
    try {
      const { unarchiveProtocol } = await import("../../protocols/archive.js");
      const { restored, error } = unarchiveProtocol(name);
      if (error) {
        // "not archived" = nothing to restore (404). A live name collision is a
        // conflict the caller resolves by renaming or removing the live copy.
        json(/not archived/.test(error) ? 404 : 409, { ok: false, error });
        return true;
      }
      json(200, { ok: true, protocol: restored });
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
      // Mirror the protocol tool's delete semantics: ?permanent=true hard-deletes,
      // default soft-archives (recoverable via POST /api/protocols/:name/unarchive
      // or protocol(action:"unarchive")).
      // Both paths only reach custom.json. An `imported` SKILL.md that has never
      // been edited isn't in there yet, so both would no-op — reported honestly
      // as 409 rather than a 200 the UI shows as success.
      const permanent = url.searchParams.get("permanent") === "true";
      if (permanent) {
        const { deleteProtocol } = await import("../../protocols/builder.js");
        const ok = deleteProtocol(name);
        if (!ok) {
          json(409, { ok: false, mode: "permanent", error: `"${name}" isn't in the editable catalog — edit it once to promote it, then delete.` });
          return true;
        }
        json(200, { ok: true, mode: "permanent" });
      } else {
        const { archiveProtocol, loadArchived } = await import("../../protocols/archive.js");
        const reason = url.searchParams.get("reason") || undefined;
        // The archive holds ONE record per name. When the name is already in
        // archived.json, archiveProtocol() "resolves" the clash by hard-deleting
        // the live record without archiving it — the live content is then gone
        // for good. That is reachable on the normal path, because createProtocol
        // only rejects collisions against the LIVE catalog, so an archived name
        // is immediately re-creatable. Refuse before taking the side effect.
        if (loadArchived().some((r) => r.protocol.name === name)) {
          json(409, {
            ok: false, mode: "archived",
            error: `"${name}" is already in the archive, and the archive keeps one copy per name — archiving this one would destroy it. Delete this copy permanently, then restore the archived one if you want it back.`,
          });
          return true;
        }
        if (archiveProtocol(name, reason) === null) {
          json(409, { ok: false, mode: "archived", error: `"${name}" isn't in the editable catalog — only user-custom protocols can be archived.` });
          return true;
        }
        json(200, { ok: true, mode: "archived" });
      }
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
