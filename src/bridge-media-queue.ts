// In-memory hand-off of a turn's outbound media from the tool dispatcher to the
// messaging bridge. Bridge turns do NOT persist their fresh tool results (with
// the media envelope) as op-message rows — only flattened history — so the
// bridge's old post-turn re-read of op_messages found no media and silently
// delivered nothing (photos broke ~6/15, then video). The dispatcher enqueues
// the bytes/paths here, where they're in hand; the bridge drains them after the
// turn, keyed by op id. Web-chat ops enqueue too but never drain (the web UI
// renders media inline) — a small cap evicts the oldest so the map stays bounded.

type PendingMedia = { images: Buffer[]; imagePaths: string[]; videoPaths: string[] };

const queue = new Map<string, PendingMedia>();
const MAX_OPS = 64;

export function enqueueBridgeMedia(
  opId: string,
  m: { imageB64?: string[]; imagePath?: string; videoPath?: string },
): void {
  if (!opId) return;
  let pending = queue.get(opId);
  if (!pending) {
    if (queue.size >= MAX_OPS) {
      const oldest = queue.keys().next().value;
      if (oldest !== undefined) queue.delete(oldest);
    }
    pending = { images: [], imagePaths: [], videoPaths: [] };
    queue.set(opId, pending);
  }
  for (const b64 of m.imageB64 ?? []) {
    try { pending.images.push(Buffer.from(b64, "base64")); } catch { /* skip malformed */ }
  }
  if (m.imagePath) pending.imagePaths.push(m.imagePath);
  if (m.videoPath) pending.videoPaths.push(m.videoPath);
}

export function drainBridgeMedia(opId: string): PendingMedia | null {
  if (!opId) return null;
  const pending = queue.get(opId);
  if (pending) queue.delete(opId);
  return pending ?? null;
}
