/**
 * The model a chat runs on (ADR 0007 §8). Picking a model in one chat sets
 * that chat's pin; other chats keep theirs. A chat with no pin runs on the
 * default in settings (`provider` / `model` / `reasoningEffort`), which is
 * what a new chat starts with.
 *
 * Kept beside the transcript, not in it: a turn rewrites the whole session log
 * from the copy it loaded, so a pin written into the log mid-turn would be
 * lost when the turn ends. This file has one small record per chat and no
 * other writer.
 *
 * The turn reads the pin as its provider/model override
 * (`routes/chat/run-chat-turn/orchestrator.ts`), the provider picker reads it
 * through `GET /api/providers?session=` and sets it through
 * `POST /api/sessions/<id>/model` (`routes/settings/providers.ts`).
 */
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore, type JsonStore } from "../util/json-store.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../providers/reasoning-effort.js";

export interface SessionModelPin {
  provider: ProviderId;
  /** Empty = the provider's default model. */
  model: string;
  effort?: ReasoningEffort;
  setAt: string;
}

interface PinFile extends Record<string, unknown> {
  pins: Record<string, SessionModelPin>;
}

/** A chat id as the client mints it (`chat-<uid>`), the IDE's `ide-<app>`,
 *  or a bridge's session id: no path separators, bounded. */
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export function isPinnableSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value) && !value.includes("..");
}

/** Parse a picker's request into a pin, or say what is wrong with it. */
export function parseModelPin(body: Record<string, unknown>): { pin: Omit<SessionModelPin, "setAt"> } | { error: string } {
  const provider = body.provider;
  if (typeof provider !== "string" || !(PROVIDER_IDS as readonly string[]).includes(provider)) {
    return { error: "provider must be one of: " + PROVIDER_IDS.join(", ") };
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model.length > 200) return { error: "model name too long" };
  const effort = body.effort;
  if (effort !== undefined && !(REASONING_EFFORTS as readonly unknown[]).includes(effort)) {
    return { error: "effort must be one of: " + REASONING_EFFORTS.join(", ") };
  }
  return { pin: { provider: provider as ProviderId, model, ...(effort ? { effort: effort as ReasoningEffort } : {}) } };
}

export function createModelPinStore(filePath: string) {
  const store: JsonStore<PinFile> = createJsonStore<PinFile>(filePath, { defaults: () => ({ pins: {} }) });
  return {
    get(sessionId: string): SessionModelPin | null {
      if (!isPinnableSessionId(sessionId)) return null;
      return store.load().pins[sessionId] ?? null;
    },
    set(sessionId: string, pin: Omit<SessionModelPin, "setAt">): SessionModelPin {
      if (!isPinnableSessionId(sessionId)) throw new Error("invalid session id");
      const record: SessionModelPin = { ...pin, setAt: new Date().toISOString() };
      store.mutate((draft) => { draft.pins[sessionId] = record; });
      return record;
    },
    clear(sessionId: string): boolean {
      if (!isPinnableSessionId(sessionId)) return false;
      return store.mutate((draft) => {
        const had = sessionId in draft.pins;
        delete draft.pins[sessionId];
        return had;
      });
    },
  };
}

export type ModelPinStore = ReturnType<typeof createModelPinStore>;

let instance: ModelPinStore | null = null;

/** The pins under the LAX data dir. */
export function sessionModelPins(): ModelPinStore {
  instance ??= createModelPinStore(join(getLaxDir(), "session-model-pins.json"));
  return instance;
}
