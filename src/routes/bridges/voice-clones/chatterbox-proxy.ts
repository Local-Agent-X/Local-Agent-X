import { CB_BASE, proxyToSidecar } from "./sidecar-proxy.js";

export async function handleChatterboxProxy(
  method: string,
  pathname: string,
  req: any,
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const sidecarPath = pathname.replace("/api/voices/chatterbox", "/clones");
  try {
    const { status, body } = await proxyToSidecar(CB_BASE(), sidecarPath, method, req);
    json(status, body);
  } catch (e) {
    if ((e as Error).message?.includes("Payload too large")) {
      json(413, { error: (e as Error).message });
      req.destroy();
      return;
    }
    json(503, {
      error: "Chatterbox sidecar unreachable",
      detail: (e as Error).message,
      hint: "Run python/chatterbox/install.ps1 to install the Studio tier",
    });
  }
}
