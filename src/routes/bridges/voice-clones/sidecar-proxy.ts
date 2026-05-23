export const CB_BASE = () => `http://127.0.0.1:${process.env.LAX_CHATTERBOX_PORT || "7010"}`;
export const SV_BASE = () => `http://127.0.0.1:${process.env.LAX_SOVITS_PORT || "7012"}`;
export const MAX_BODY = 25 * 1024 * 1024;

export async function readBodyBytes(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY) throw new Error("Payload too large (max 25MB)");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function probeSidecar(base: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return await r.json() as Record<string, unknown>;
  } catch { /* sidecar down */ }
  return null;
}

export async function proxyToSidecar(
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
