/**
 * Pins resolveProviderContext against the CONFIG CLASS that killed every
 * classifier in the app (2026-07 soak): settings.json selects a provider with
 * no usable credential (e.g. "codex" after the Codex login lapsed) while
 * another provider (e.g. anthropic CLI OAuth) IS credentialed. The chat
 * resolver reroutes and keeps working; this seam used to resolve the raw
 * settings value, fail credential resolution, and return null — silently
 * disabling compaction summaries, end-of-turn memory extraction, and every
 * other classifier while chat looked healthy.
 *
 * Contract pinned here:
 *   - selected provider credentialed → byte-identical to the old behavior
 *     (provider + credential + settings model passed through)
 *   - selected provider uncredentialed, another credentialed → the EFFECTIVE
 *     provider chat would reroute to (shared chain: xai → anthropic → codex),
 *     with the orphaned settings model blanked
 *   - NO provider credentialed → null (unchanged)
 *   - ollama/local sentinel path unchanged
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SecretsStore } from "../secrets.js";

// Providers whose sync hasCredential() probe reports presence.
const credsPresent = new Set<string>();
// Providers whose async resolveCredential() yields a usable key.
const resolvable = new Map<string, string>();
let savedSettings: Record<string, unknown> = {};
let secretsSingleton: SecretsStore | null =
  { get: () => undefined } as unknown as SecretsStore;

vi.mock("../settings.js", () => ({
  loadSettings: () => savedSettings,
  getSetting: () => undefined,
}));

vi.mock("../auth/resolve.js", () => ({
  resolveCredential: vi.fn(async (provider: string) => {
    const credential = resolvable.get(provider);
    return credential
      ? { provider, credential, source: "secrets-store" as const }
      : null;
  }),
}));

vi.mock("../secrets.js", () => ({
  getSecretsStoreSingleton: () => secretsSingleton,
}));

vi.mock("./registry.js", () => {
  const ids = [
    "anthropic", "codex", "xai", "openai", "gemini",
    "cerebras", "ollama-cloud", "custom", "local",
  ];
  const PROVIDERS: Record<string, { auth: { hasCredential: () => boolean } }> = {};
  for (const id of ids) {
    PROVIDERS[id] = { auth: { hasCredential: () => credsPresent.has(id) } };
  }
  return { PROVIDERS };
});

const { resolveProviderContext } = await import("./resolve-provider-context.js");

beforeEach(() => {
  credsPresent.clear();
  resolvable.clear();
  savedSettings = {};
  secretsSingleton = { get: () => undefined } as unknown as SecretsStore;
});

describe("resolveProviderContext — credentialed selected provider (pinned unchanged)", () => {
  it("returns the selected provider, its credential, and the settings model as-is", async () => {
    savedSettings = { provider: "codex", model: "gpt-5.5" };
    resolvable.set("codex", "key-codex");

    const ctx = await resolveProviderContext();
    expect(ctx).toEqual({ provider: "codex", apiKey: "key-codex", model: "gpt-5.5" });
  });

  it("keeps the ollama/local sentinel path unchanged", async () => {
    savedSettings = { provider: "ollama", model: "llama3:8b" };
    const ctx = await resolveProviderContext();
    expect(ctx).toEqual({ provider: "ollama", apiKey: "ollama", model: "llama3:8b" });
  });
});

describe("resolveProviderContext — the dead-classifier config class", () => {
  it("selected provider uncredentialed + another credentialed → reroutes to the effective provider", async () => {
    // The live soak shape: settings say codex, no codex credential, anthropic
    // CLI credential present. Chat reroutes; classifiers must follow.
    savedSettings = { provider: "codex", model: "gpt-5.5" };
    credsPresent.add("anthropic");
    resolvable.set("anthropic", "key-anthropic");

    const ctx = await resolveProviderContext();
    expect(ctx).toEqual({
      provider: "anthropic",
      apiKey: "key-anthropic",
      // The settings model belongs to codex — must be blanked so callers
      // apply anthropic's own default, mirroring the chat reroute.
      model: "",
    });
  });

  it("mirrors the chat fallback priority (xai first)", async () => {
    savedSettings = { provider: "codex" };
    credsPresent.add("anthropic");
    credsPresent.add("xai");
    resolvable.set("anthropic", "key-anthropic");
    resolvable.set("xai", "key-xai");

    const ctx = await resolveProviderContext();
    expect(ctx?.provider).toBe("xai");
    expect(ctx?.apiKey).toBe("key-xai");
  });

  it("returns null when NO provider is credentialed (unchanged)", async () => {
    savedSettings = { provider: "codex" };
    const ctx = await resolveProviderContext();
    expect(ctx).toBeNull();
  });

  it("returns null when the fallback probe passes but its credential does not resolve", async () => {
    savedSettings = { provider: "codex" };
    credsPresent.add("anthropic"); // sync probe says yes…
    // …but resolveCredential("anthropic") yields nothing.
    const ctx = await resolveProviderContext();
    expect(ctx).toBeNull();
  });

  it("returns null (no reroute probe) when the secrets vault has not booted", async () => {
    savedSettings = { provider: "codex" };
    credsPresent.add("anthropic");
    resolvable.set("anthropic", "key-anthropic");
    secretsSingleton = null;

    const ctx = await resolveProviderContext();
    expect(ctx).toBeNull();
  });
});
