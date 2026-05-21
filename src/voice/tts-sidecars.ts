// HTTP probes to the three voice sidecars (Chatterbox at :7010, SoVITS at
// :7012, Lite at :7008). Used by synthesize() so bridges (Telegram,
// WhatsApp) can hit the clone-tier engines without going through Lite's
// WebSocket — Lite is WS-only and server-to-server audio over WS is
// overkill for a one-shot text-to-WAV call.
//
// Two probe shapes:
//   - trySidecarSynth: clone-tier (Chatterbox/SoVITS). Health → /clones list
//     → POST to /clones/{id}/synth. Skips with no clones loaded.
//   - tryLiteSynth: Lite sidecar (Kokoro+Whisper). Flat /synth that takes
//     {text, voice?, speed?} and returns WAV. The no-clone fallback so
//     bridges still get a real human-quality voice when neither
//     clone-tier engine has a clone loaded.

import { createLogger } from "../logger.js";

const logger = createLogger("voice");

export async function trySidecarSynth(port: number, tierLabel: string, text: string): Promise<Buffer | null> {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!health.ok) {
      logger.info(`[synthesize] ${tierLabel} :${port} health not ok (${health.status})`);
      return null;
    }
  } catch (e) {
    logger.info(`[synthesize] ${tierLabel} :${port} unreachable (${(e as Error).message})`);
    return null;
  }

  let cloneId: string | null = null;
  try {
    const list = await fetch(`http://127.0.0.1:${port}/clones`, { signal: AbortSignal.timeout(2000) });
    if (!list.ok) {
      logger.info(`[synthesize] ${tierLabel} /clones returned ${list.status}`);
      return null;
    }
    const data = await list.json() as { clones?: Array<{ id?: string }> };
    const first = (data.clones ?? []).find(c => typeof c.id === "string");
    if (!first?.id) {
      logger.info(`[synthesize] ${tierLabel} :${port} has no clones — skipping (clone-only sidecar)`);
      return null;
    }
    cloneId = first.id;
  } catch (e) {
    logger.warn(`[synthesize] ${tierLabel} /clones threw: ${(e as Error).message}`);
    return null;
  }

  try {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/clones/${encodeURIComponent(cloneId)}/synth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      logger.warn(`[synthesize] ${tierLabel} /synth returned ${r.status}`);
      return null;
    }
    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);
    logger.info(`[synthesize] ${tierLabel} clone=${cloneId} bytes=${buf.length} in ${Date.now() - t0}ms`);
    return buf.length > 0 ? buf : null;
  } catch (e) {
    logger.warn(`[synthesize] ${tierLabel} /synth threw: ${(e as Error).message}`);
    return null;
  }
}

export async function tryLiteSynth(port: number, text: string, voice?: string, speed?: number): Promise<Buffer | null> {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!health.ok) {
      logger.info(`[synthesize] lite :${port} health not ok (${health.status})`);
      return null;
    }
  } catch (e) {
    logger.info(`[synthesize] lite :${port} unreachable (${(e as Error).message})`);
    return null;
  }
  try {
    const t0 = Date.now();
    const body: Record<string, unknown> = { text };
    if (voice) body.voice = voice;
    if (typeof speed === "number") body.speed = speed;
    const r = await fetch(`http://127.0.0.1:${port}/synth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      logger.warn(`[synthesize] lite /synth returned ${r.status}`);
      return null;
    }
    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);
    logger.info(`[synthesize] lite voice=${voice ?? "default"} bytes=${buf.length} in ${Date.now() - t0}ms`);
    return buf.length > 0 ? buf : null;
  } catch (e) {
    logger.warn(`[synthesize] lite /synth threw: ${(e as Error).message}`);
    return null;
  }
}
