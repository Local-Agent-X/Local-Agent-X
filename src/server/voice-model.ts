import { backgroundModelFor } from "../providers/registry.js";
import type { ProviderId } from "../providers/provider-ids.js";

/**
 * The model a SPOKEN voice turn runs on.
 *
 * A reasoning chat model (gpt-5.6-sol, claude-opus-5) thinks for many seconds
 * before its first token — pure dead air on a voice call (measured 13-16s ttft
 * on gpt-5.6-sol). Lowering its reasoning effort isn't enough: gpt-5.6's floor
 * is "low" and even that is slow + unreliable. So the spoken hop routes to the
 * SELECTED provider's own fast tier — its declared `backgroundModel`
 * (codex → gpt-5.4-mini, openai → gpt-4o-mini, gemini → gemini-2.0-flash,
 * xai → non-reasoning grok, anthropic → claude-haiku-4-5) — keeping whatever
 * provider the user chose. The provider does NOT change; only the model does.
 * Heavy/long work still delegates to full-power workers, which run the chat
 * model at full depth — the fast tier is only the conversational turn.
 *
 * Override precedence:
 *   1. `voiceModel` setting = an explicit model id → pinned to that model.
 *   2. `voiceModel` setting = "chat" / "same" → opt out; use the chat model
 *      verbatim (accepts the reasoning latency, e.g. to talk to full Claude).
 *   3. unset → the provider's fast tier. Providers with a dynamic catalog and
 *      no declared backgroundModel (local, ollama-cloud) fall through to the
 *      chat model unchanged — a local box keeps whatever it already runs.
 *
 * `getSetting` is injected so this stays a pure, unit-testable function with no
 * settings-module import in its graph.
 */
export function resolveVoiceModel(
  provider: ProviderId,
  chatModel: string,
  getSetting: <T>(key: string) => T | undefined,
): string {
  let pinned = "";
  try { pinned = (getSetting<string>("voiceModel") || "").trim(); } catch { /* settings unreadable → default */ }

  const lowered = pinned.toLowerCase();
  if (lowered === "chat" || lowered === "same") return chatModel;
  if (pinned) return pinned;

  return backgroundModelFor(provider, chatModel);
}
