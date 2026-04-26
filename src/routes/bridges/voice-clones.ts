import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";

export const handleVoiceCloneRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── Voice clones (Pro tier, RVC sidecar at :7009) ──
  // The Pro tier runs ultimate-rvc in a separate venv (~/.lax/python-rvc/venv/).
  // If the sidecar isn't running, /api/voices/* returns 503 with an
  // installer hint — the chat UI uses that to gate the cloning UI.
  if (url.pathname === "/api/voices/tier" || url.pathname === "/api/voices/clones" || url.pathname.startsWith("/api/voices/clones/")) {
    const rvcBase = `http://127.0.0.1:${process.env.LAX_RVC_PORT || "7009"}`;
    try {
      // Capability probe: fast healthz check the UI can poll on page load.
      if (method === "GET" && url.pathname === "/api/voices/tier") {
        try {
          const r = await fetch(`${rvcBase}/healthz`, { signal: AbortSignal.timeout(1500) });
          const body = await r.json() as Record<string, unknown>;
          json(200, { tier: "pro", ...body });
        } catch {
          json(200, { tier: "lite", ready: false, reason: "RVC sidecar not running" });
        }
        return true;
      }
      const sidecarPath = url.pathname.replace("/api/voices/clones", "/clones");
      const proxyOpts: RequestInit = { method, signal: AbortSignal.timeout(60_000) };
      if (method === "POST" || method === "PATCH") {
        const MAX = 25 * 1024 * 1024;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          total += (chunk as Buffer).length;
          if (total > MAX) { json(413, { error: "Payload too large (max 25MB)" }); req.destroy(); return true; }
          chunks.push(chunk as Buffer);
        }
        proxyOpts.headers = { "Content-Type": "application/json" };
        proxyOpts.body = Buffer.concat(chunks);
      }
      const r = await fetch(`${rvcBase}${sidecarPath}`, proxyOpts);
      json(r.status, await r.json().catch(() => ({})));
      return true;
    } catch (e) {
      json(503, { error: "RVC sidecar unreachable", detail: (e as Error).message, hint: "Run python/rvc/install.ps1 to install Pro tier" });
      return true;
    }
  }

  return false;
};
