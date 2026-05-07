// Tier 4 TTS provider registry.
//
// Adapters register themselves under a string key (kokoro, chatterbox-clone,
// edge-tts, ...) at module-import time. tier4-factory.ts imports the built-in
// providers so they auto-register; createTier4() then delegates here.
//
// This mirrors the upstream `tts.providers.<name>` pattern and gives the UI a
// single list-and-pick surface without per-variant branching in the consumer.

import type { Tier4Callbacks, Tier4Config, Tier4StreamingTTS } from "./types.js";

export interface TtsProviderOptions extends Tier4Config {
  referenceWavPath?: string;
}

export type TtsProviderFactory = (
  opts: TtsProviderOptions,
  cb: Tier4Callbacks,
) => Promise<Tier4StreamingTTS>;

export interface TtsProviderEntry {
  name: string;
  factory: TtsProviderFactory;
  /** Optional readiness probe for the UI. Returns ready=false with a reason
   *  when an external dep is missing or a precondition isn't met. */
  readiness?: () => { ready: boolean; reason?: string };
}

const REGISTRY = new Map<string, TtsProviderEntry>();

export function registerTtsProvider(
  name: string,
  factory: TtsProviderFactory,
  readiness?: () => { ready: boolean; reason?: string },
): void {
  REGISTRY.set(name, { name, factory, readiness });
}

export function hasTtsProvider(name: string): boolean {
  return REGISTRY.has(name);
}

export async function createTtsProvider(
  name: string,
  opts: TtsProviderOptions,
  cb: Tier4Callbacks,
): Promise<Tier4StreamingTTS> {
  const entry = REGISTRY.get(name);
  if (!entry) {
    throw new Error(`unknown tier 4 provider: ${name}`);
  }
  return entry.factory(opts, cb);
}

export function listTtsProviders(): { name: string; ready: boolean; reason?: string }[] {
  const out: { name: string; ready: boolean; reason?: string }[] = [];
  for (const entry of REGISTRY.values()) {
    if (entry.readiness) {
      const r = entry.readiness();
      out.push({ name: entry.name, ready: r.ready, reason: r.reason });
    } else {
      out.push({ name: entry.name, ready: true });
    }
  }
  return out;
}
