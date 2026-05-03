/**
 * Pause-on-auth-needed. When the assistant emits a message asking the
 * user to log in, paste a token, approve, etc., call the pauseCallback
 * (if provided) to fetch the user's response and push it as a user
 * message before continuing. Without a pauseCallback this middleware
 * is a no-op.
 *
 * Mirrors the pause path at the end of the legacy run-standard loop —
 * the regex matches the same auth-needed phrases.
 */

import type { LoopMiddleware } from "../types.js";

const PAUSE_RE = /\b(please (log in|sign in|enter|provide|confirm)|need(s)? you to|waiting for you|i need your|can you (log in|sign in|paste|approve)|blocked\s+on\s+(2fa|captcha|payment))\b/i;

export const pauseMiddleware: LoopMiddleware = {
  name: "pause",

  async afterModelCall(ctx, result) {
    const text = result.assistantContent;
    if (!text || !PAUSE_RE.test(text)) return { kind: "continue" };
    if (!ctx.req.pauseCallback) return { kind: "continue" };

    ctx.req.onEvent?.({ type: "stream", delta: "\n\n[Waiting for user input...]" });
    const userResponse = await ctx.req.pauseCallback(text);
    return { kind: "nudge", message: userResponse, reason: "pause" };
  },
};
