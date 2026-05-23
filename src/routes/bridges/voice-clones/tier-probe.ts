import { CB_BASE, SV_BASE, probeSidecar } from "./sidecar-proxy.js";

// SoVITS is preferred when available (supports trained voices); Chatterbox
// remains as zero-shot fallback.
export async function handleTierProbe(
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const [cb, sv] = await Promise.all([probeSidecar(CB_BASE()), probeSidecar(SV_BASE())]);
  json(200, {
    tier: sv?.ready ? "studio-trained" : (cb?.ready ? "studio" : "lite"),
    chatterbox: cb ? { ready: !!cb.ready, ...cb } : { ready: false },
    sovits: sv ? { ready: !!sv.ready, ...sv } : { ready: false },
  });
}
