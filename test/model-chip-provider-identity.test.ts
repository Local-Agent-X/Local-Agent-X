// @vitest-environment happy-dom
//
// The composer's model chip renders provider and model from two different
// places: the model comes from `current.model`, the provider label from the
// picker list. Those can disagree, and when they did the chip stated a pairing
// that exists nowhere — "OpenAI Codex ▸ grok-4.5" while settings.json said
// provider=xai. The cause was a positional fallback:
//
//     providers.find(p => p.active) || providers[0]
//
// The server sets `active: current.provider === id` and only lists providers
// whose credential gate passed, so a selection with no credential is absent
// from the list and NOTHING is active — at which point `|| providers[0]`
// silently substituted an unrelated provider's name. That is worse than a
// blank: it reads as a confident answer and hides the real fault (the selected
// provider has no credential, so every turn against it fails).
//
// These lock the resolver to id-matching and pin the disconnected signal.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const statusBarJs = readFileSync(join(here, "../public/js/chat-status-bar.js"), "utf8");
const identityJs = readFileSync(join(here, "../public/js/chat-provider-identity.js"), "utf8");
const html = readFileSync(join(here, "../public/app.html"), "utf8");
const css = readFileSync(join(here, "../public/css/app.css"), "utf8");

type Providers = { providers: Array<{ id: string; name: string; models: string[]; active: boolean }>; current: { provider: string; model: string } };
let resolve: (d: unknown) => { id: string } | null;
let complete: (d: unknown) => boolean;

beforeAll(() => {
  resolve = new Function(`${identityJs}\nreturn laxResolveActiveProvider;`)();
  complete = new Function(`${identityJs}\nreturn isProvidersComplete;`)();
});

// The exact shape /api/providers returned on the machine that produced the bug:
// settings said xai/grok-4.5, but xai had no credential so it was never pushed.
const DISCONNECTED: Providers = {
  providers: [
    { id: "codex", name: "OpenAI Codex", models: ["gpt-5.5"], active: false },
    { id: "anthropic", name: "Anthropic Claude", models: ["claude-opus-5"], active: false },
    { id: "local", name: "Local Models", models: [], active: false },
  ],
  current: { provider: "xai", model: "grok-4.5" },
};

const CONNECTED: Providers = {
  providers: [
    { id: "xai", name: "xAI Grok", models: ["grok-4.5"], active: true },
    { id: "codex", name: "OpenAI Codex", models: ["gpt-5.5"], active: false },
  ],
  current: { provider: "xai", model: "grok-4.5" },
};

describe("model chip provider identity", () => {
  it("resolves the entry whose id matches the selection", () => {
    expect(resolve(CONNECTED)?.id).toBe("xai");
  });

  it("returns null rather than a neighbour when the selection is not connected", () => {
    // The whole bug in one assertion: providers[0] is codex, and codex is not
    // the answer just because it happens to be first.
    expect(resolve(DISCONNECTED)).toBeNull();
  });

  it("ignores a stale `active` flag that disagrees with the selection", () => {
    // active is server-derived from current.provider; if the two ever drift,
    // current.provider is the one that decides which model actually runs.
    const drifted = {
      providers: [
        { id: "codex", name: "OpenAI Codex", models: ["gpt-5.5"], active: true },
        { id: "xai", name: "xAI Grok", models: ["grok-4.5"], active: false },
      ],
      current: { provider: "xai", model: "grok-4.5" },
    };
    expect(resolve(drifted)?.id).toBe("xai");
  });

  it("survives empty, malformed and half-built payloads", () => {
    expect(resolve(null)).toBeNull();
    expect(resolve({})).toBeNull();
    expect(resolve({ providers: [] })).toBeNull();
    expect(resolve({ providers: [{ id: "codex" }] })).toBeNull();          // no current
    expect(resolve({ current: { provider: "xai" } })).toBeNull();          // no list
  });

  it("treats a disconnected selection as settled, not as a warming cache", () => {
    // isProvidersComplete gates ensureProvidersLoaded's retry loop. A missing
    // credential never resolves by refetching, so retrying ten times over 12s
    // on every boot would be pure waste.
    expect(complete(DISCONNECTED)).toBe(true);
    expect(complete(CONNECTED)).toBe(true);
    // A connected provider whose model list is still warming is NOT settled.
    expect(complete({
      providers: [{ id: "xai", name: "xAI Grok", models: [], active: true }],
      current: { provider: "xai", model: "grok-4.5" },
    })).toBe(false);
    expect(complete({ providers: [], current: { provider: "xai" } })).toBe(false);
  });

  it("never falls back positionally anywhere in the status bar", () => {
    // isProvidersComplete carried its own copy of the same unsafe expression.
    // Match executable source only — the resolver's own comment quotes the old
    // expression verbatim to explain why it's gone. `[^:]` before the slashes
    // keeps `https://` in string literals from being treated as a comment.
    // Split on \r?\n — the repo checks out CRLF, and a trailing \r left by a
    // plain split("\n") blocks the `$` anchor (\r is a line terminator, so `.`
    // stops before it and `$` without /m only matches the true end).
    const strip = (s: string) => s.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
    for (const [name, src] of [["chat-status-bar.js", statusBarJs], ["chat-provider-identity.js", identityJs]] as const) {
      expect.soft(strip(src), `${name} must not fall back positionally`)
        .not.toMatch(/find\(p => p\.active\)\s*\|\|\s*(data\.)?providers\[0\]/);
    }
    expect(strip(statusBarJs)).toContain("laxResolveActiveProvider");
  });

  it("names a dropped provider from the ungated registry, not from a bare id", () => {
    // The registry feed is the only one with no credential gating, so it's the
    // only thing that can still say "xai" means "xAI Grok". The fetch itself
    // belongs to provider-registry.js (the renderer's one reader) — this module
    // only holds the derived id→label map, because the chip renders
    // synchronously and can't await.
    expect(identityJs).toContain("laxProviderLabels(await laxProviderRegistry())");
    expect(identityJs).toMatch(/function laxProviderLabel\(/);
    expect(statusBarJs).toContain("laxProviderLabel(currentProvider)");
  });

  it("loads the identity module before the status bar that calls into it", () => {
    const idx = (f: string) => html.indexOf(`/js/${f}`);
    expect(idx("chat-provider-identity.js")).toBeGreaterThan(-1);
    expect(idx("chat-provider-identity.js")).toBeLessThan(idx("chat-status-bar.js"));
  });

  it("flags the disconnected state visibly and outside the collapsible spans", () => {
    // The narrow-column container steps hide .mc-provider; the warning must not
    // ride along with it or the signal vanishes exactly when space is tight.
    expect(statusBarJs).toContain('class="mc-warn"');
    expect(statusBarJs).toMatch(/model-chip\$\{connected \? '' : ' disconnected'\}/);
    expect(css).toContain(".model-chip.disconnected");
    const narrowSteps = css.slice(css.indexOf("@container chat (max-width: 720px)"));
    expect(narrowSteps).not.toContain("mc-warn{display:none}");
    expect(narrowSteps).not.toMatch(/\.mc-warn[^{]*\{[^}]*display:\s*none/);
  });
});
