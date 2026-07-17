import { CB_BASE, VX_BASE, probeSidecar } from "./sidecar-proxy.js";

// VoxCPM (Studio-Vox) is the primary clone engine; Chatterbox (Studio) is
// the backup. When neither is up the voice stack is on Lite's built-in
// Kokoro voices.
export async function handleTierProbe(
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const [vx, cb] = await Promise.all([probeSidecar(VX_BASE()), probeSidecar(CB_BASE())]);
  json(200, {
    tier: vx?.ready ? "studio-vox" : (cb?.ready ? "studio" : "lite"),
    voxcpm: vx ? { ready: !!vx.ready, ...vx } : { ready: false },
    chatterbox: cb ? { ready: !!cb.ready, ...cb } : { ready: false },
  });
}
