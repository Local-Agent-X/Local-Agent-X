import { VX_BASE, proxyToSidecar } from "./sidecar-proxy.js";

export async function handleVoxcpmProxy(
  method: string,
  pathname: string,
  req: any,
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const sidecarPath = pathname.replace("/api/voices/voxcpm", "/clones");
  try {
    const { status, body } = await proxyToSidecar(VX_BASE(), sidecarPath, method, req);
    json(status, body);
  } catch (e) {
    if ((e as Error).message?.includes("Payload too large")) {
      json(413, { error: (e as Error).message });
      req.destroy();
      return;
    }
    json(503, {
      error: "VoxCPM sidecar unreachable",
      detail: (e as Error).message,
      hint: "Run python/voxcpm/install.ps1 to install the Studio-Vox tier",
    });
  }
}
