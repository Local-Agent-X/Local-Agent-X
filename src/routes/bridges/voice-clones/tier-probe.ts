import { CB_BASE, probeSidecar } from "./sidecar-proxy.js";

// Chatterbox (zero-shot reference-clip clones) is the only clone engine;
// when it isn't up the voice stack is on Lite's built-in Kokoro voices.
export async function handleTierProbe(
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const cb = await probeSidecar(CB_BASE());
  json(200, {
    tier: cb?.ready ? "studio" : "lite",
    chatterbox: cb ? { ready: !!cb.ready, ...cb } : { ready: false },
  });
}
