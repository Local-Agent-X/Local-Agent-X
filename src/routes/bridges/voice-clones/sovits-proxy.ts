import { SV_BASE, proxyToSidecar } from "./sidecar-proxy.js";

export async function handleSovitsProxy(
  method: string,
  pathname: string,
  req: any,
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const sidecarPath = pathname.replace("/api/voices/sovits", "/clones");
  try {
    const { status, body } = await proxyToSidecar(SV_BASE(), sidecarPath, method, req);
    json(status, body);
  } catch (e) {
    if ((e as Error).message?.includes("Payload too large")) {
      json(413, { error: (e as Error).message });
      req.destroy();
      return;
    }
    json(503, {
      error: "SoVITS sidecar unreachable",
      detail: (e as Error).message,
      hint: "Run python/sovits/server.py (needs api_v2 at :7011 too)",
    });
  }
}
