import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";

const CB_BASE = () => `http://127.0.0.1:${process.env.LAX_CHATTERBOX_PORT || "7010"}`;
const SV_BASE = () => `http://127.0.0.1:${process.env.LAX_SOVITS_PORT || "7012"}`;
const MAX_BODY = 25 * 1024 * 1024;

async function readBodyBytes(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY) throw new Error("Payload too large (max 25MB)");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function probeSidecar(base: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return await r.json() as Record<string, unknown>;
  } catch { /* sidecar down */ }
  return null;
}

async function proxyToSidecar(
  base: string, path: string, method: string, req: any,
): Promise<{ status: number; body: unknown }> {
  const opts: RequestInit = { method, signal: AbortSignal.timeout(120_000) };
  if (method === "POST" || method === "PATCH") {
    opts.body = await readBodyBytes(req);
    opts.headers = { "Content-Type": "application/json" };
  }
  const r = await fetch(`${base}${path}`, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

export const handleVoiceCloneRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── /api/voices/tier — capability probe; reports both Chatterbox + SoVITS ──
  // SoVITS is preferred when available (supports trained voices); Chatterbox
  // remains as zero-shot fallback.
  if (method === "GET" && url.pathname === "/api/voices/tier") {
    const [cb, sv] = await Promise.all([probeSidecar(CB_BASE()), probeSidecar(SV_BASE())]);
    json(200, {
      tier: sv?.ready ? "studio-trained" : (cb?.ready ? "studio" : "lite"),
      chatterbox: cb ? { ready: !!cb.ready, ...cb } : { ready: false },
      sovits: sv ? { ready: !!sv.ready, ...sv } : { ready: false },
    });
    return true;
  }

  // ── /api/voices/chatterbox/* → Chatterbox sidecar (:7010) ──
  if (url.pathname === "/api/voices/chatterbox" || url.pathname.startsWith("/api/voices/chatterbox/")) {
    const sidecarPath = url.pathname.replace("/api/voices/chatterbox", "/clones");
    try {
      const { status, body } = await proxyToSidecar(CB_BASE(), sidecarPath, method, req);
      json(status, body);
      return true;
    } catch (e) {
      if ((e as Error).message?.includes("Payload too large")) {
        json(413, { error: (e as Error).message });
        req.destroy();
        return true;
      }
      json(503, {
        error: "Chatterbox sidecar unreachable",
        detail: (e as Error).message,
        hint: "Run python/chatterbox/install.ps1 to install the Studio tier",
      });
      return true;
    }
  }

  // ── /api/voices/sovits/* → SoVITS clones sidecar (:7012) ──
  // Same surface as Chatterbox so the chat picker can treat both uniformly.
  // Exposes /clones list + register, /clones/{id}/synth, etc.
  if (url.pathname === "/api/voices/sovits" || url.pathname.startsWith("/api/voices/sovits/")) {
    const sidecarPath = url.pathname.replace("/api/voices/sovits", "/clones");
    try {
      const { status, body } = await proxyToSidecar(SV_BASE(), sidecarPath, method, req);
      json(status, body);
      return true;
    } catch (e) {
      if ((e as Error).message?.includes("Payload too large")) {
        json(413, { error: (e as Error).message });
        req.destroy();
        return true;
      }
      json(503, {
        error: "SoVITS sidecar unreachable",
        detail: (e as Error).message,
        hint: "Run python/sovits/server.py (needs api_v2 at :7011 too)",
      });
      return true;
    }
  }

  return false;
};
