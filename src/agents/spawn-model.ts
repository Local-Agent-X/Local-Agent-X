/**
 * The model a caller picked for one spawned run (`agent_spawn`'s `model`
 * argument, written `provider/model`): rung 1 of `resolveAgentModel`
 * (invoke.ts), above the project roster's and the template's own. An
 * orchestrator uses it to put each task on the model the user wants for it
 * (ADR 0007 §8).
 */
import { PROVIDER_IDS, type ProviderId } from "../providers/provider-ids.js";
import type { AgentModelPin } from "./types.js";

/** Undefined when none was given; an error naming what is wrong otherwise. */
export function modelPinFromArg(raw: unknown): { pin: AgentModelPin } | { error: string } | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return { error: "model must be a string written `provider/model`." };
  const at = raw.indexOf("/");
  const provider = (at < 0 ? raw : raw.slice(0, at)).trim();
  const model = at < 0 ? "" : raw.slice(at + 1).trim();
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
    return { error: `model: unknown provider "${provider}". Write it as provider/model, with a provider from: ${PROVIDER_IDS.join(", ")}.` };
  }
  if (!model) return { error: `model: name the model after the provider, e.g. ${provider}/<model>.` };
  return { pin: { provider: provider as ProviderId, model } };
}
