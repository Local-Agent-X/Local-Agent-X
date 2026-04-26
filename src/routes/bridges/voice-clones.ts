import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";

const RVC_BASE = () => `http://127.0.0.1:${process.env.LAX_RVC_PORT || "7009"}`;
const CB_BASE = () => `http://127.0.0.1:${process.env.LAX_CHATTERBOX_PORT || "7010"}`;
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

export const handleVoiceCloneRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── /api/voices/tier — capability probe (used by chat UI on page load) ──
  // Reports which optional voice tiers are reachable so the picker can
  // surface only what's actually installed.
  if (method === "GET" && url.pathname === "/api/voices/tier") {
    const probe = async (base: string) => {
      try {
        const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
        return r.ok ? (await r.json() as Record<string, unknown>) : null;
      } catch { return null; }
    };
    const [rvc, cb] = await Promise.all([probe(RVC_BASE()), probe(CB_BASE())]);
    json(200, {
      tier: cb?.ready ? "studio" : (rvc?.ready ? "pro" : "lite"),
      rvc: rvc ? { ready: !!rvc.ready, ...rvc } : { ready: false },
      chatterbox: cb ? { ready: !!cb.ready, ...cb } : { ready: false },
    });
    return true;
  }

  // ── /api/voices/clones/* → RVC sidecar (:7009) ──
  if (url.pathname === "/api/voices/clones" || url.pathname.startsWith("/api/voices/clones/")) {
    const sidecarPath = url.pathname.replace("/api/voices/clones", "/clones");
    return proxyTo(RVC_BASE(), sidecarPath, method, req, json, "RVC");
  }

  // ── /api/voices/chatterbox/* → Chatterbox sidecar (:7010) ──
  if (url.pathname === "/api/voices/chatterbox" || url.pathname.startsWith("/api/voices/chatterbox/")) {
    const sidecarPath = url.pathname.replace("/api/voices/chatterbox", "/clones");
    return proxyTo(CB_BASE(), sidecarPath, method, req, json, "Chatterbox");
  }

  return false;
};

async function proxyTo(
  base: string,
  sidecarPath: string,
  method: string,
  req: any,
  json: (status: number, data: unknown) => void,
  label: string,
): Promise<boolean> {
  try {
    const opts: RequestInit = { method, signal: AbortSignal.timeout(120_000) };
    if (method === "POST" || method === "PATCH") {
      try {
        opts.body = await readBodyBytes(req);
      } catch (e) {
        json(413, { error: (e as Error).message });
        req.destroy();
        return true;
      }
      opts.headers = { "Content-Type": "application/json" };
    }
    const r = await fetch(`${base}${sidecarPath}`, opts);
    json(r.status, await r.json().catch(() => ({})));
    return true;
  } catch (e) {
    json(503, {
      error: `${label} sidecar unreachable`,
      detail: (e as Error).message,
      hint: label === "RVC"
        ? "Run python/rvc/install.ps1 to install Pro tier"
        : "Run python/chatterbox/install.ps1 to install Studio tier",
    });
    return true;
  }
}
